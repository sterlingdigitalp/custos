import { newId } from '@platform/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import {
  duePendingEvents,
  enqueueOutboxEvent,
  markDelivered,
  markPoison,
  markRetry,
  poisonCount,
} from './outbox.js'

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

describe('platform_outbox state machine', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('creates platform_outbox table via openDatabase', () => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_outbox'
    `).all() as Array<{ name: string }>
    expect(tables).toHaveLength(1)
  })

  it('enqueue is idempotent on eventId (INSERT OR IGNORE)', () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 'history.market.daily.v1', envelope: testEnvelope(eventId) })
    enqueueOutboxEvent(db, { eventId, eventType: 'history.market.daily.v1', envelope: testEnvelope(eventId) })
    enqueueOutboxEvent(db, { eventId, eventType: 'history.rank.spike.v1', envelope: testEnvelope(eventId) })
    const count = (db.prepare('SELECT COUNT(*) AS c FROM platform_outbox').get() as { c: number }).c
    expect(count).toBe(1)
  })

  it('enqueued records start pending with zero attempts', () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 'history.rank.spike.v1', envelope: testEnvelope(eventId) })
    const due = duePendingEvents(db, new Date().toISOString())
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({
      eventId,
      eventType: 'history.rank.spike.v1',
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      sequence: null,
    })
  })

  it('duePendingEvents respects next_attempt_at', () => {
    const future = newId('evt')
    const due = newId('evt')
    enqueueOutboxEvent(db, { eventId: future, eventType: 't', envelope: testEnvelope(future) })
    enqueueOutboxEvent(db, { eventId: due, eventType: 't', envelope: testEnvelope(due) })
    const now = Date.parse('2026-07-13T00:00:00.000Z')
    const futureRow = duePendingEvents(db, new Date(now).toISOString()).find((r) => r.eventId === future)!
    markRetry(db, futureRow.id, {
      lastError: 'boom',
      nextAttemptAt: new Date(now + 60_000).toISOString(),
    })
    const dueRow = duePendingEvents(db, new Date(now).toISOString()).find((r) => r.eventId === due)!
    markRetry(db, dueRow.id, {
      lastError: 'boom',
      nextAttemptAt: new Date(now - 1_000).toISOString(),
    })
    expect(duePendingEvents(db, new Date(now).toISOString()).map((r) => r.eventId)).toEqual([due])
  })

  it('markDelivered stores sequence and increments attempts', () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const row = duePendingEvents(db, new Date().toISOString())[0]!
    markDelivered(db, row.id, { deliveredAt: '2026-07-13T01:00:00.000Z', sequence: 42 })
    const stored = db.prepare('SELECT * FROM platform_outbox WHERE id = ?').get(row.id) as Record<string, unknown>
    expect(stored.status).toBe('delivered')
    expect(stored.delivered_at).toBe('2026-07-13T01:00:00.000Z')
    expect(stored.sequence).toBe(42)
    expect(stored.attempts).toBe(1)
    expect(duePendingEvents(db, new Date().toISOString())).toHaveLength(0)
  })

  it('markRetry keeps status pending and records backoff', () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const row = duePendingEvents(db, new Date().toISOString())[0]!
    markRetry(db, row.id, { lastError: 'HTTP 503', nextAttemptAt: '2026-07-13T00:05:00.000Z' })
    const stored = db.prepare('SELECT * FROM platform_outbox WHERE id = ?').get(row.id) as Record<string, unknown>
    expect(stored.status).toBe('pending')
    expect(stored.attempts).toBe(1)
    expect(stored.last_error).toBe('HTTP 503')
    expect(stored.next_attempt_at).toBe('2026-07-13T00:05:00.000Z')
  })

  it('markPoison permanently excludes from due pending', () => {
    const eventId = newId('evt')
    enqueueOutboxEvent(db, { eventId, eventType: 't', envelope: testEnvelope(eventId) })
    const row = duePendingEvents(db, new Date().toISOString())[0]!
    markPoison(db, row.id, { lastError: 'HTTP 422: schema invalid' })
    const stored = db.prepare('SELECT * FROM platform_outbox WHERE id = ?').get(row.id) as Record<string, unknown>
    expect(stored.status).toBe('poison')
    expect(stored.attempts).toBe(1)
    expect(duePendingEvents(db, new Date().toISOString())).toHaveLength(0)
    expect(poisonCount(db)).toBe(1)
  })
})
