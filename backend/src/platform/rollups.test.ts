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
import { computeDailyRollups, integerMedian, utcDayString } from './rollups.js'
import { detectAndRecordSpikes } from './spikes.js'

const productId = newId('prd', 900_000)
const config: HubConfig = {
  baseUrl: 'http://hub.test',
  token: 'tok',
  accountId: newId('acct', 900_001),
  marketplaceId: 'ATVPDKIKX0DER',
}

function snap(
  db: DatabaseHandle,
  asin: string,
  ts: string,
  opts: {
    buyBox?: number | null
    lowestNew?: number | null
    lowestFba?: number | null
    offers?: number | null
    fbaOffers?: number | null
    rank?: number | null
    rankCategory?: string | null
  } = {},
) {
  insertSnapshot(db, {
    asin,
    ts,
    buyBoxPrice: opts.buyBox ?? null,
    lowestNewPrice: opts.lowestNew ?? null,
    lowestFbaPrice: opts.lowestFba ?? null,
    offerCount: opts.offers ?? null,
    fbaOfferCount: opts.fbaOffers ?? null,
    salesRank: opts.rank ?? null,
    rankCategory: opts.rankCategory ?? null,
  })
}

describe('integerMedian (lower-middle for even)', () => {
  it('returns null for empty', () => {
    expect(integerMedian([])).toBeNull()
  })

  it('odd count picks middle', () => {
    expect(integerMedian([3, 1, 2])).toBe(2)
    expect(integerMedian([10])).toBe(10)
  })

  it('even count picks lower-middle', () => {
    // sorted [1,2,3,4] → lower-middle index 1 → 2
    expect(integerMedian([4, 1, 3, 2])).toBe(2)
    // [10, 20] → lower-middle 10
    expect(integerMedian([20, 10])).toBe(10)
  })
})

describe('computeDailyRollups', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('computes cents medians for a completed UTC day (odd + even)', () => {
    createProduct(db, { asin: 'B00ROLL01' })
    upsertProductMapping(db, { asin: 'B00ROLL01', canonicalProductId: productId })
    // Day 2026-07-14 — three buybox prices: 10.00, 12.00, 11.00 → median 1100 cents
    snap(db, 'B00ROLL01', '2026-07-14T01:00:00.000Z', { buyBox: 10.0, offers: 5, rank: 100, rankCategory: 'A' })
    snap(db, 'B00ROLL01', '2026-07-14T12:00:00.000Z', { buyBox: 12.0, offers: 7, rank: 200, rankCategory: 'B' })
    snap(db, 'B00ROLL01', '2026-07-14T23:00:00.000Z', { buyBox: 11.0, offers: 6, rank: 150, rankCategory: null })
    // Four lowestNew for even median: 1,2,3,4 dollars → cents 100,200,300,400 → lower-middle 200
    snap(db, 'B00ROLL01', '2026-07-14T02:00:00.000Z', { lowestNew: 1 })
    // re-use existing rows for lowestNew? Need four values — add on separate snaps
    // Actually the first three have lowestNew null; add three more with lowestNew
    // Simpler: one day with four snaps all having lowestNew
    // We'll check buybox (3 snaps that have prices) and offer median of 3: 5,7,6 → 6

    const now = new Date('2026-07-15T12:00:00.000Z') // day 14 completed
    const result = computeDailyRollups(db, config, { now })
    expect(result.daysComputed).toBe(1)
    expect(result.daysEmitted).toBe(1)

    const row = db.prepare('SELECT * FROM daily_rollups WHERE asin = ? AND date = ?')
      .get('B00ROLL01', '2026-07-14') as Record<string, unknown>
    expect(row.snapshot_count).toBe(4)
    // buyBox values: 10, 12, 11 → cents 1000,1200,1100 → median 1100
    expect(row.buybox_median_cents).toBe(1100)
    expect(row.buybox_min_cents).toBe(1000)
    expect(row.buybox_max_cents).toBe(1200)
    // offers: 5,7,6,null → median of [5,6,7] = 6
    expect(row.offer_count_median).toBe(6)
    // ranks: 100,200,150,null → [100,150,200] median 150
    expect(row.sales_rank_median).toBe(150)
    expect(row.sales_rank_min).toBe(100)
    expect(row.sales_rank_max).toBe(200)
    // latest non-null rankCategory: walk reverse — snap3 null, snap2 'B'
    expect(row.rank_category).toBe('B')
    expect(row.emitted_event_id).toBeTruthy()

    const due = duePendingEvents(db, now.toISOString())
    expect(due).toHaveLength(1)
    const envelope = JSON.parse(due[0]!.envelope)
    expect(envelope.eventType).toBe('history.market.daily.v1')
    validateHistoryPayload('history.market.daily.v1', envelope.payload)
    expect(Object.keys(envelope.payload).sort()).toEqual(
      historyPayloadPropertyKeys('history.market.daily.v1').sort(),
    )
    expect(Object.keys(envelope.payload).sort()).toEqual(
      Object.keys(
        (historyEventPayloadSchemas['history.market.daily.v1'] as { properties: object }).properties,
      ).sort(),
    )
    expect(envelope.payload.snapshotCount).toBe(4)
    expect(envelope.payload.buyBoxMedian).toEqual({ amount: '11.00', currency: 'USD' })
  })

  it('even-count cents median uses lower-middle', () => {
    createProduct(db, { asin: 'B00EVEN' })
    // Four buybox: 1,2,3,4 dollars → lower-middle of [100,200,300,400] = 200
    for (const [i, price] of [1, 2, 3, 4].entries()) {
      snap(db, 'B00EVEN', `2026-07-10T0${i}:00:00.000Z`, { buyBox: price })
    }
    computeDailyRollups(db, null, { now: new Date('2026-07-11T00:00:00.000Z') })
    const row = db.prepare('SELECT buybox_median_cents FROM daily_rollups WHERE asin = ?')
      .get('B00EVEN') as { buybox_median_cents: number }
    expect(row.buybox_median_cents).toBe(200)
  })

  it('respects UTC day boundary — does not roll current incomplete day', () => {
    createProduct(db, { asin: 'B00BOUND' })
    snap(db, 'B00BOUND', '2026-07-16T01:00:00.000Z', { buyBox: 9.99 })
    // now is still 2026-07-16 → day 16 incomplete, day 15 has zero snaps → nothing
    const result = computeDailyRollups(db, null, { now: new Date('2026-07-16T15:00:00.000Z') })
    expect(result.daysComputed).toBe(0)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM daily_rollups').get() as { c: number }).c
    expect(count).toBe(0)

    // After midnight UTC, day 16 is complete
    const result2 = computeDailyRollups(db, null, { now: new Date('2026-07-17T00:00:00.000Z') })
    expect(result2.daysComputed).toBe(1)
  })

  it('multi-day backfill processes oldest completed days first', () => {
    createProduct(db, { asin: 'B00MULTI' })
    snap(db, 'B00MULTI', '2026-07-10T12:00:00.000Z', { buyBox: 1 })
    snap(db, 'B00MULTI', '2026-07-12T12:00:00.000Z', { buyBox: 2 })
    // gap on 11th — zero snapshots → skipped (absent)
    const result = computeDailyRollups(db, null, { now: new Date('2026-07-13T00:00:00.000Z') })
    expect(result.daysComputed).toBe(2)
    const days = (db.prepare('SELECT date FROM daily_rollups WHERE asin = ? ORDER BY date')
      .all('B00MULTI') as Array<{ date: string }>).map((r) => r.date)
    expect(days).toEqual(['2026-07-10', '2026-07-12'])
  })

  it('skips zero-snapshot days entirely (no row, no event)', () => {
    createProduct(db, { asin: 'B00ZERO' })
    snap(db, 'B00ZERO', '2026-07-10T12:00:00.000Z', { buyBox: 1 })
    computeDailyRollups(db, null, { now: new Date('2026-07-12T00:00:00.000Z') })
    // only day 10 has snaps; day 11 absent
    const rows = db.prepare('SELECT date FROM daily_rollups').all() as Array<{ date: string }>
    expect(rows.map((r) => r.date)).toEqual(['2026-07-10'])
  })

  it('idempotent re-run: existing emitted_event_id → skip', () => {
    createProduct(db, { asin: 'B00IDEM' })
    upsertProductMapping(db, { asin: 'B00IDEM', canonicalProductId: productId })
    snap(db, 'B00IDEM', '2026-07-10T12:00:00.000Z', { buyBox: 5 })
    const now = new Date('2026-07-11T00:00:00.000Z')
    const first = computeDailyRollups(db, config, { now })
    expect(first.daysEmitted).toBe(1)
    const eventId = (db.prepare('SELECT emitted_event_id FROM daily_rollups WHERE asin = ?')
      .get('B00IDEM') as { emitted_event_id: string }).emitted_event_id
    const second = computeDailyRollups(db, config, { now })
    expect(second.daysSkippedExisting).toBe(1)
    expect(second.daysEmitted).toBe(0)
    expect(duePendingEvents(db, now.toISOString())).toHaveLength(1)
    expect(
      (db.prepare('SELECT emitted_event_id FROM daily_rollups WHERE asin = ?')
        .get('B00IDEM') as { emitted_event_id: string }).emitted_event_id,
    ).toBe(eventId)
  })

  it('standalone-then-configured emits once when config appears', () => {
    createProduct(db, { asin: 'B00LATER' })
    upsertProductMapping(db, { asin: 'B00LATER', canonicalProductId: productId })
    snap(db, 'B00LATER', '2026-07-10T12:00:00.000Z', { buyBox: 5 })
    const now = new Date('2026-07-11T00:00:00.000Z')

    // Standalone: store rollup, no event
    const first = computeDailyRollups(db, null, { now })
    expect(first.daysComputed).toBe(1)
    expect(first.daysEmitted).toBe(0)
    expect(
      (db.prepare('SELECT emitted_event_id FROM daily_rollups WHERE asin = ?')
        .get('B00LATER') as { emitted_event_id: string | null }).emitted_event_id,
    ).toBeNull()
    expect(duePendingEvents(db, now.toISOString())).toHaveLength(0)

    // Config appears: emit once for the existing standalone-era row
    const second = computeDailyRollups(db, config, { now })
    expect(second.daysEmitted).toBe(1)
    expect(duePendingEvents(db, now.toISOString())).toHaveLength(1)

    // Third run: skip
    const third = computeDailyRollups(db, config, { now })
    expect(third.daysSkippedExisting).toBe(1)
    expect(third.daysEmitted).toBe(0)
    expect(duePendingEvents(db, now.toISOString())).toHaveLength(1)
  })

  it('estimated_sales counts history_spikes for that UTC day', () => {
    createProduct(db, { asin: 'B00SALES' })
    // Snapshots that form a spike on day 14
    snap(db, 'B00SALES', '2026-07-14T10:00:00.000Z', { rank: 5000, buyBox: 10 })
    snap(db, 'B00SALES', '2026-07-14T11:00:00.000Z', { rank: 2000, buyBox: 10 })
    detectAndRecordSpikes(db, null, { now: new Date('2026-07-14T12:00:00.000Z') })
    expect((db.prepare('SELECT COUNT(*) AS c FROM history_spikes').get() as { c: number }).c).toBe(1)

    computeDailyRollups(db, null, { now: new Date('2026-07-15T00:00:00.000Z') })
    const row = db.prepare('SELECT estimated_sales FROM daily_rollups WHERE asin = ? AND date = ?')
      .get('B00SALES', '2026-07-14') as { estimated_sales: number }
    expect(row.estimated_sales).toBe(1)
  })

  it('utcDayString is UTC-based', () => {
    expect(utcDayString('2026-07-15T23:30:00.000Z')).toBe('2026-07-15')
    expect(utcDayString(new Date('2026-07-16T00:00:00.000Z'))).toBe('2026-07-16')
  })
})
