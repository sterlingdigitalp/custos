import { historyEventPayloadSchemas, newId } from '@platform/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createProduct,
  insertSnapshot,
  upsertProductMapping,
} from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import type { HubConfig } from './config.js'
import { historyPayloadPropertyKeys, validateHistoryPayload } from './events.js'
import { duePendingEvents } from './outbox.js'
import { detectAndRecordSpikes } from './spikes.js'

const productId = newId('prd', 800_000)
const config: HubConfig = {
  baseUrl: 'http://hub.test',
  token: 'tok',
  accountId: newId('acct', 800_001),
  marketplaceId: 'ATVPDKIKX0DER',
}

function seedPair(
  db: DatabaseHandle,
  asin: string,
  rankBefore: number,
  rankAfter: number,
  tsBefore = '2026-07-15T10:00:00.000Z',
  tsAfter = '2026-07-15T11:00:00.000Z',
) {
  insertSnapshot(db, {
    asin,
    ts: tsBefore,
    buyBoxPrice: 10,
    lowestNewPrice: null,
    lowestFbaPrice: null,
    offerCount: 1,
    fbaOfferCount: 1,
    salesRank: rankBefore,
    rankCategory: 'Sports',
  })
  insertSnapshot(db, {
    asin,
    ts: tsAfter,
    buyBoxPrice: 10,
    lowestNewPrice: null,
    lowestFbaPrice: null,
    offerCount: 1,
    fbaOfferCount: 1,
    salesRank: rankAfter,
    rankCategory: 'Sports',
  })
}

describe('detectAndRecordSpikes', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('records a spike when rank improves ≥ threshold from base > minBaseRank', () => {
    createProduct(db, { asin: 'B00SPIKE01' })
    upsertProductMapping(db, { asin: 'B00SPIKE01', canonicalProductId: productId })
    // 5000 → 3000 = 40% improvement, base > 1000
    seedPair(db, 'B00SPIKE01', 5000, 3000)

    const result = detectAndRecordSpikes(db, config)
    expect(result.recorded).toBe(1)
    expect(result.emitted).toBe(1)

    const spike = db.prepare('SELECT * FROM history_spikes WHERE asin = ?').get('B00SPIKE01') as Record<string, unknown>
    expect(spike.rank_before).toBe(5000)
    expect(spike.rank_after).toBe(3000)
    expect(spike.detected_at).toBe('2026-07-15T11:00:00.000Z')
    expect(spike.emitted_event_id).toBeTruthy()

    const due = duePendingEvents(db, new Date().toISOString())
    expect(due).toHaveLength(1)
    expect(due[0]!.eventType).toBe('history.rank.spike.v1')
    const envelope = JSON.parse(due[0]!.envelope)
    expect(envelope.source).toBe('history')
    validateHistoryPayload('history.rank.spike.v1', envelope.payload)
    expect(Object.keys(envelope.payload).sort()).toEqual(
      historyPayloadPropertyKeys('history.rank.spike.v1').sort(),
    )
    // Cross-check against contract schema property set
    expect(Object.keys(envelope.payload).sort()).toEqual(
      Object.keys(
        (historyEventPayloadSchemas['history.rank.spike.v1'] as { properties: object }).properties,
      ).sort(),
    )
  })

  it('threshold edge: exactly 30% counts; just under does not', () => {
    createProduct(db, { asin: 'B00EDGE30' })
    // 1000 * 0.7 = 700 exactly at 30% — but minBaseRank gate: need > 1000
    // Use 2000 → 1400 = exactly 30%
    seedPair(db, 'B00EDGE30', 2000, 1400)
    expect(detectAndRecordSpikes(db, null, { threshold: 30, minBaseRank: 1000 }).recorded).toBe(1)

    createProduct(db, { asin: 'B00EDGE29' })
    // 2000 → 1401 ≈ 29.95% — should NOT fire
    seedPair(db, 'B00EDGE29', 2000, 1401)
    expect(detectAndRecordSpikes(db, null, { threshold: 30, minBaseRank: 1000 }).recorded).toBe(0)
  })

  it('minBaseRank gate: previous.salesRank must be > minBaseRank', () => {
    createProduct(db, { asin: 'B00BASE' })
    // previous = 1000, minBaseRank default 1000 → not > 1000
    seedPair(db, 'B00BASE', 1000, 500)
    expect(detectAndRecordSpikes(db, null).recorded).toBe(0)

    createProduct(db, { asin: 'B00BASE2' })
    seedPair(db, 'B00BASE2', 1001, 500)
    expect(detectAndRecordSpikes(db, null).recorded).toBe(1)
  })

  it('dedups by asin+detected_at on re-run', () => {
    createProduct(db, { asin: 'B00DEDUP' })
    upsertProductMapping(db, { asin: 'B00DEDUP', canonicalProductId: productId })
    seedPair(db, 'B00DEDUP', 5000, 2000)
    expect(detectAndRecordSpikes(db, config).recorded).toBe(1)
    expect(detectAndRecordSpikes(db, config).recorded).toBe(0)
    expect(duePendingEvents(db, new Date().toISOString())).toHaveLength(1)
  })

  it('records spike without event when unmapped / standalone (config null)', () => {
    createProduct(db, { asin: 'B00ALONE' })
    seedPair(db, 'B00ALONE', 5000, 2000)
    const result = detectAndRecordSpikes(db, null)
    expect(result.recorded).toBe(1)
    expect(result.emitted).toBe(0)
    const spike = db.prepare('SELECT * FROM history_spikes WHERE asin = ?').get('B00ALONE') as Record<string, unknown>
    expect(spike.emitted_event_id).toBeNull()
    expect(duePendingEvents(db, new Date().toISOString())).toHaveLength(0)
  })

  it('records without emit when config present but product unmapped', () => {
    createProduct(db, { asin: 'B00NOMAP' })
    seedPair(db, 'B00NOMAP', 5000, 2000)
    const result = detectAndRecordSpikes(db, config)
    expect(result.recorded).toBe(1)
    expect(result.emitted).toBe(0)
    expect(duePendingEvents(db, new Date().toISOString())).toHaveLength(0)
  })
})
