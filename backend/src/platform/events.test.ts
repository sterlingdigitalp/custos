import { historyEventPayloadSchemas, newId } from '@platform/contract'
import { describe, expect, it } from 'vitest'

import type { HubConfig } from './config.js'
import {
  buildHistoryEvent,
  historyPayloadPropertyKeys,
  validateHistoryPayload,
} from './events.js'

const config: HubConfig = {
  baseUrl: 'http://hub.test',
  token: 'tok',
  accountId: newId('acct', 700_000),
  marketplaceId: 'ATVPDKIKX0DER',
}

const productId = newId('prd', 700_001)

function validDaily(overrides: Record<string, unknown> = {}) {
  return {
    productId,
    date: '2026-07-15',
    snapshotCount: 3,
    buyBoxMedian: { amount: '19.99', currency: 'USD' },
    buyBoxMin: { amount: '18.00', currency: 'USD' },
    buyBoxMax: { amount: '21.00', currency: 'USD' },
    lowestNewMedian: null,
    lowestFbaMedian: { amount: '20.00', currency: 'USD' },
    offerCountMedian: 12,
    fbaOfferCountMedian: 4,
    salesRankMedian: 5000,
    salesRankMin: 4000,
    salesRankMax: 6000,
    rankCategory: 'Sports',
    estimatedSales: 1,
    ...overrides,
  }
}

function validSpike(overrides: Record<string, unknown> = {}) {
  return {
    productId,
    detectedAt: '2026-07-15T12:00:00.000Z',
    rankBefore: 5000,
    rankAfter: 3000,
    rankCategory: 'Sports',
    improvementPercent: 40,
    estimatedUnits: 1,
    ...overrides,
  }
}

describe('buildHistoryEvent + validateHistoryPayload', () => {
  it('builds a valid daily envelope with source history and product aggregate', () => {
    const payload = validDaily()
    const envelope = buildHistoryEvent({
      config,
      type: 'history.market.daily.v1',
      productId,
      payload,
      occurredAt: '2026-07-16T00:00:00.000Z',
    })
    expect(envelope.source).toBe('history')
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.eventType).toBe('history.market.daily.v1')
    expect(envelope.accountId).toBe(config.accountId)
    expect(envelope.marketplaceId).toBe(config.marketplaceId)
    expect(envelope.aggregate).toEqual({ type: 'product', id: productId })
    expect(envelope.productId).toBe(productId)
    expect(envelope.listingId).toBeNull()
    expect(envelope.correlationId).toBeNull()
    expect(envelope.causationId).toBeNull()
    expect(envelope.eventId).toMatch(/^evt_/)
  })

  it('builds a valid spike envelope', () => {
    const payload = validSpike()
    const envelope = buildHistoryEvent({
      config,
      type: 'history.rank.spike.v1',
      productId,
      payload,
      occurredAt: payload.detectedAt as string,
    })
    expect(envelope.eventType).toBe('history.rank.spike.v1')
    expect(envelope.payload).toEqual(payload)
  })

  it('rejects extra keys (exact key set)', () => {
    expect(() => validateHistoryPayload('history.market.daily.v1', validDaily({ asin: 'B00X' })))
      .toThrow(/exact keys/)
  })

  it('rejects missing required snapshotCount / bad date', () => {
    const missing = validDaily()
    delete (missing as { snapshotCount?: unknown }).snapshotCount
    expect(() => validateHistoryPayload('history.market.daily.v1', missing as Record<string, unknown>))
      .toThrow()
    expect(() => validateHistoryPayload('history.market.daily.v1', validDaily({ date: '07/15/2026' })))
      .toThrow(/YYYY-MM-DD/)
  })

  it('rejects snapshotCount < 1 and bad Money', () => {
    expect(() => validateHistoryPayload('history.market.daily.v1', validDaily({ snapshotCount: 0 })))
      .toThrow(/snapshotCount/)
    expect(() =>
      validateHistoryPayload(
        'history.market.daily.v1',
        validDaily({ buyBoxMedian: { amount: 19.99, currency: 'USD' } }),
      ),
    ).toThrow(/Money/)
  })

  it('rejects invalid spike fields', () => {
    expect(() =>
      validateHistoryPayload('history.rank.spike.v1', validSpike({ rankBefore: 0 })),
    ).toThrow(/rankBefore/)
    expect(() =>
      validateHistoryPayload('history.rank.spike.v1', validSpike({ improvementPercent: -1 })),
    ).toThrow(/improvementPercent/)
    expect(() =>
      validateHistoryPayload('history.rank.spike.v1', validSpike({ estimatedUnits: 0 })),
    ).toThrow(/estimatedUnits/)
  })

  it('cross-checks local key sets against historyEventPayloadSchemas properties', () => {
    for (const type of ['history.market.daily.v1', 'history.rank.spike.v1'] as const) {
      const local = historyPayloadPropertyKeys(type).sort()
      const schemaKeys = Object.keys(
        (historyEventPayloadSchemas[type] as { properties: Record<string, unknown> }).properties,
      ).sort()
      expect(local).toEqual(schemaKeys)
      // Every emitted fixture must pass validation AND cover the full property set.
      const payload = type === 'history.market.daily.v1' ? validDaily() : validSpike()
      expect(Object.keys(payload).sort()).toEqual(schemaKeys)
      expect(() => validateHistoryPayload(type, payload)).not.toThrow()
      buildHistoryEvent({
        config,
        type,
        productId,
        payload,
        occurredAt: '2026-07-16T00:00:00.000Z',
      })
    }
  })
})
