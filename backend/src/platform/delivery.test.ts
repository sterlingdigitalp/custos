import { newId } from '@platform/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import {
  BACKOFF_CAP_MS,
  computeBackoffMs,
  HubDeliveryWorker,
  parseRetryAfterMs,
  type HubEndpointConfig,
} from './delivery.js'
import { enqueueOutboxEvent, poisonCount } from './outbox.js'

function testEnvelope(eventId: string): string {
  return JSON.stringify({
    eventId,
    eventType: 'history.market.daily.v1',
    schemaVersion: 1,
    source: 'history',
    accountId: 'acct_test',
    marketplaceId: 'ATVPDKIKX0DER',
    aggregate: { type: 'product', id: 'prd_test' },
    productId: 'prd_test',
    listingId: null,
    occurredAt: '2026-07-13T00:00:00.000Z',
    correlationId: null,
    causationId: null,
    payload: {},
  })
}

function configuredHub(): HubEndpointConfig {
  return { baseUrl: 'https://hub.example', token: 'hub-tok' }
}

function rowFor(db: DatabaseHandle, eventId: string) {
  return db.prepare('SELECT * FROM platform_outbox WHERE event_id = ?').get(eventId) as Record<string, unknown>
}

describe('computeBackoffMs / parseRetryAfterMs', () => {
  it('grows exponentially and caps at BACKOFF_CAP_MS', () => {
    const fixed = () => 0
    expect(computeBackoffMs(0, fixed)).toBe(1_000)
    expect(computeBackoffMs(1, fixed)).toBe(2_000)
    expect(computeBackoffMs(2, fixed)).toBe(4_000)
    expect(computeBackoffMs(20, fixed)).toBe(BACKOFF_CAP_MS)
  })

  it('parseRetryAfterMs handles delta-seconds and HTTP-date', () => {
    const now = Date.parse('2026-07-13T00:00:00.000Z')
    expect(parseRetryAfterMs('120', now)).toBe(120_000)
    expect(parseRetryAfterMs(null, now)).toBeNull()
    const date = 'Mon, 13 Jul 2026 00:02:00 GMT'
    expect(parseRetryAfterMs(date, now)).toBe(120_000)
  })
})

describe('HubDeliveryWorker.tick', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('is a no-op when Hub endpoint is undefined', async () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    let calls = 0
    const worker = new HubDeliveryWorker(db, undefined, {
      fetch: (async () => {
        calls++
        throw new Error('should not be called')
      }) as typeof fetch,
    })
    const result = await worker.tick()
    expect(result).toEqual({ delivered: 0, retried: 0, poisoned: 0, stopped: false })
    expect(calls).toBe(0)
    expect(rowFor(db, eventId).status).toBe('pending')
  })

  it('201 ack with matching eventId marks delivered', async () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const worker = new HubDeliveryWorker(db, configuredHub(), {
      fetch: (async (_url: unknown, init: unknown) => {
        const req = init as RequestInit
        expect(req.method).toBe('POST')
        expect((req.headers as Record<string, string>).Authorization).toBe('Bearer hub-tok')
        return new Response(
          JSON.stringify({ eventId, sequence: 42, receivedAt: '2026-07-13T00:00:00.000Z' }),
          { status: 201 },
        )
      }) as typeof fetch,
    })
    const result = await worker.tick()
    expect(result).toEqual({ delivered: 1, retried: 0, poisoned: 0, stopped: false })
    expect(rowFor(db, eventId).status).toBe('delivered')
    expect(rowFor(db, eventId).sequence).toBe(42)
  })

  it('200 with duplicate:true and matching eventId marks delivered', async () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const worker = new HubDeliveryWorker(db, configuredHub(), {
      fetch: (async () =>
        new Response(
          JSON.stringify({ eventId, sequence: 7, receivedAt: '2026-07-13T00:00:00.000Z', duplicate: true }),
          { status: 200 },
        )) as typeof fetch,
    })
    const result = await worker.tick()
    expect(result.delivered).toBe(1)
    expect(rowFor(db, eventId).status).toBe('delivered')
  })

  it('mismatched ack eventId is retried', async () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const worker = new HubDeliveryWorker(db, configuredHub(), {
      fetch: (async () =>
        new Response(JSON.stringify({ eventId: 'evt_other', sequence: 1 }), { status: 201 })) as typeof fetch,
    })
    const result = await worker.tick()
    expect(result).toEqual({ delivered: 0, retried: 1, poisoned: 0, stopped: false })
    expect(rowFor(db, eventId).status).toBe('pending')
  })

  it('429 with Retry-After honors the header', async () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const nowMs = Date.parse('2026-07-13T00:00:00.000Z')
    const worker = new HubDeliveryWorker(db, configuredHub(), {
      now: () => nowMs,
      fetch: (async () =>
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } })) as typeof fetch,
    })
    await worker.tick()
    const stored = rowFor(db, eventId)
    expect(stored.status).toBe('pending')
    expect(Date.parse(stored.next_attempt_at as string)).toBe(nowMs + 120_000)
  })

  it('5xx grows exponential backoff', async () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const nowMs = Date.parse('2026-07-13T00:00:00.000Z')
    const worker = new HubDeliveryWorker(db, configuredHub(), {
      now: () => nowMs,
      fetch: (async () => new Response('boom', { status: 503 })) as typeof fetch,
    })
    await worker.tick()
    let stored = rowFor(db, eventId)
    const firstDelay = Date.parse(stored.next_attempt_at as string) - nowMs
    expect(firstDelay).toBeGreaterThanOrEqual(2000)
    expect(firstDelay).toBeLessThan(3000)

    db.prepare('UPDATE platform_outbox SET next_attempt_at = ? WHERE event_id = ?')
      .run(new Date(nowMs - 1000).toISOString(), eventId)
    await worker.tick()
    stored = rowFor(db, eventId)
    const secondDelay = Date.parse(stored.next_attempt_at as string) - nowMs
    expect(secondDelay).toBeGreaterThanOrEqual(4000)
    expect(secondDelay).toBeLessThan(5000)
  })

  it('422 marks poison and is never retried', async () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const worker = new HubDeliveryWorker(db, configuredHub(), {
      fetch: (async () => new Response('schema invalid', { status: 422 })) as typeof fetch,
    })
    const result = await worker.tick()
    expect(result.poisoned).toBe(1)
    expect(rowFor(db, eventId).status).toBe('poison')
    expect(poisonCount(db)).toBe(1)

    let calls = 0
    const worker2 = new HubDeliveryWorker(db, configuredHub(), {
      fetch: (async () => {
        calls++
        return new Response('schema invalid', { status: 422 })
      }) as typeof fetch,
    })
    await worker2.tick()
    expect(calls).toBe(0)
  })

  it('401/403 halt the batch without touching the record', async () => {
    for (const status of [401, 403]) {
      const eventId = newId('evt')
      enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
      const worker = new HubDeliveryWorker(db, configuredHub(), {
        fetch: (async () => new Response('nope', { status })) as typeof fetch,
      })
      const result = await worker.tick()
      expect(result.stopped).toBe(true)
      expect(rowFor(db, eventId).status).toBe('pending')
      expect(rowFor(db, eventId).attempts).toBe(0)
    }
  })

  it('network throw is retried', async () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const worker = new HubDeliveryWorker(db, configuredHub(), {
      fetch: (async () => {
        throw new Error('ECONNRESET')
      }) as typeof fetch,
    })
    const result = await worker.tick()
    expect(result.retried).toBe(1)
    expect(rowFor(db, eventId).last_error).toBe('ECONNRESET')
  })

  it('stops the batch before later records once a 401 is hit', async () => {
    const a = newId('evt')
    const b = newId('evt')
    enqueueOutboxEvent(db, { eventId: a, eventType: 't', envelope: testEnvelope(a) })
    enqueueOutboxEvent(db, { eventId: b, eventType: 't', envelope: testEnvelope(b) })
    let calls = 0
    const worker = new HubDeliveryWorker(db, configuredHub(), {
      fetch: (async () => {
        calls++
        return new Response('unauthorized', { status: 401 })
      }) as typeof fetch,
    })
    const result = await worker.tick()
    expect(result.stopped).toBe(true)
    expect(calls).toBe(1)
  })

  it('408 and 425 are retried', async () => {
    for (const status of [408, 425]) {
      const eventId = newId('evt')
      enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
      const worker = new HubDeliveryWorker(db, configuredHub(), {
        fetch: (async () => new Response('retry', { status })) as typeof fetch,
      })
      const result = await worker.tick()
      expect(result.retried).toBe(1)
      expect(rowFor(db, eventId).status).toBe('pending')
    }
  })
})
