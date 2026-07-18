// Daily market rollups (PLATFORM-INTEGRATION.md D8, §2 history.market.daily.v1).
//
// Day D is rolled up only once `now` is on D+1 or later (UTC). All un-rolled
// completed days that have ≥1 snapshot are processed oldest-first (natural
// backfill). Zero-snapshot days are ABSENT — never emitted, never stored.
//
// Aggregate math is entirely in integer cents (D7). Integer median uses the
// lower-middle element for even-length sorted samples (document choice).

import { getMappingByAsin, listProducts } from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'
import type { HubConfig } from './config.js'
import { buildHistoryEvent } from './events.js'
import { centsToMoneyOrNull, dollarsToCents } from './money.js'
import { enqueueOutboxEvent } from './outbox.js'

export interface RollupOptions {
  now?: Date
}

export interface RollupResult {
  products: number
  daysComputed: number
  daysEmitted: number
  daysSkippedExisting: number
}

interface SnapshotRow {
  ts: string
  buyBoxPrice: number | null
  lowestNewPrice: number | null
  lowestFbaPrice: number | null
  offerCount: number | null
  fbaOfferCount: number | null
  salesRank: number | null
  rankCategory: string | null
}

interface DailyRollupRow {
  id: number
  asin: string
  date: string
  snapshot_count: number
  buybox_median_cents: number | null
  buybox_min_cents: number | null
  buybox_max_cents: number | null
  lowest_new_median_cents: number | null
  lowest_fba_median_cents: number | null
  offer_count_median: number | null
  fba_offer_count_median: number | null
  sales_rank_median: number | null
  sales_rank_min: number | null
  sales_rank_max: number | null
  rank_category: string | null
  estimated_sales: number | null
  emitted_event_id: string | null
  computed_at: string
}

/**
 * Integer median: for odd n, the middle element; for even n, the lower-middle
 * element (index n/2 - 1 on a 0-based sorted array). Avoids inventing values
 * that were never observed.
 */
export function integerMedian(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  if (n % 2 === 1) return sorted[Math.floor(n / 2)]!
  return sorted[n / 2 - 1]!
}

function minOf(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.min(...values)
}

function maxOf(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.max(...values)
}

export function utcDayString(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate
  return d.toISOString().slice(0, 10)
}

function nextUtcDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function dayBounds(dateStr: string): { start: string; end: string } {
  return {
    start: `${dateStr}T00:00:00.000Z`,
    end: `${nextUtcDay(dateStr)}T00:00:00.000Z`,
  }
}

function completedDaysUpTo(now: Date): string {
  // Last completed UTC day is yesterday when now is any time on "today".
  const today = utcDayString(now)
  const d = new Date(`${today}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function collectCents(rows: SnapshotRow[], field: 'buyBoxPrice' | 'lowestNewPrice' | 'lowestFbaPrice'): number[] {
  const out: number[] = []
  for (const row of rows) {
    const cents = dollarsToCents(row[field])
    if (cents !== null) out.push(cents)
  }
  return out
}

function collectInts(rows: SnapshotRow[], field: 'offerCount' | 'fbaOfferCount' | 'salesRank'): number[] {
  const out: number[] = []
  for (const row of rows) {
    const v = row[field]
    if (v !== null && v !== undefined) out.push(v)
  }
  return out
}

function latestNonNullRankCategory(rows: SnapshotRow[]): string | null {
  // rows ordered by ts ASC — walk reverse for latest non-null
  for (let i = rows.length - 1; i >= 0; i--) {
    const cat = rows[i]!.rankCategory
    if (cat !== null && cat !== undefined) return cat
  }
  return null
}

function countSpikesForDay(db: DatabaseHandle, asin: string, dateStr: string): number {
  const { start, end } = dayBounds(dateStr)
  return (db.prepare(`
    SELECT COUNT(*) AS c FROM history_spikes
    WHERE asin = ? AND detected_at >= ? AND detected_at < ?
  `).get(asin, start, end) as { c: number }).c
}

function getExistingRollup(
  db: DatabaseHandle,
  asin: string,
  dateStr: string,
): DailyRollupRow | undefined {
  return db.prepare(
    'SELECT * FROM daily_rollups WHERE asin = ? AND date = ?',
  ).get(asin, dateStr) as DailyRollupRow | undefined
}

function daysWithSnapshots(db: DatabaseHandle, asin: string, lastCompleted: string): string[] {
  // Distinct UTC days that have ≥1 snapshot and are fully completed.
  const rows = db.prepare(`
    SELECT DISTINCT substr(ts, 1, 10) AS day
    FROM snapshots
    WHERE asin = ? AND substr(ts, 1, 10) <= ?
    ORDER BY day ASC
  `).all(asin, lastCompleted) as Array<{ day: string }>
  return rows.map((r) => r.day)
}

function loadDaySnapshots(db: DatabaseHandle, asin: string, dateStr: string): SnapshotRow[] {
  const { start, end } = dayBounds(dateStr)
  return db.prepare(`
    SELECT ts, buyBoxPrice, lowestNewPrice, lowestFbaPrice,
           offerCount, fbaOfferCount, salesRank, rankCategory
    FROM snapshots
    WHERE asin = ? AND ts >= ? AND ts < ?
    ORDER BY ts ASC, id ASC
  `).all(asin, start, end) as SnapshotRow[]
}

interface Aggregates {
  snapshotCount: number
  buyboxMedianCents: number | null
  buyboxMinCents: number | null
  buyboxMaxCents: number | null
  lowestNewMedianCents: number | null
  lowestFbaMedianCents: number | null
  offerCountMedian: number | null
  fbaOfferCountMedian: number | null
  salesRankMedian: number | null
  salesRankMin: number | null
  salesRankMax: number | null
  rankCategory: string | null
  estimatedSales: number
}

function aggregateDay(db: DatabaseHandle, asin: string, dateStr: string, rows: SnapshotRow[]): Aggregates {
  const buyBox = collectCents(rows, 'buyBoxPrice')
  const lowestNew = collectCents(rows, 'lowestNewPrice')
  const lowestFba = collectCents(rows, 'lowestFbaPrice')
  const offers = collectInts(rows, 'offerCount')
  const fbaOffers = collectInts(rows, 'fbaOfferCount')
  const ranks = collectInts(rows, 'salesRank')
  return {
    snapshotCount: rows.length,
    buyboxMedianCents: integerMedian(buyBox),
    buyboxMinCents: minOf(buyBox),
    buyboxMaxCents: maxOf(buyBox),
    lowestNewMedianCents: integerMedian(lowestNew),
    lowestFbaMedianCents: integerMedian(lowestFba),
    offerCountMedian: integerMedian(offers),
    fbaOfferCountMedian: integerMedian(fbaOffers),
    salesRankMedian: integerMedian(ranks),
    salesRankMin: minOf(ranks),
    salesRankMax: maxOf(ranks),
    rankCategory: latestNonNullRankCategory(rows),
    estimatedSales: countSpikesForDay(db, asin, dateStr),
  }
}

function upsertRollup(
  db: DatabaseHandle,
  asin: string,
  dateStr: string,
  agg: Aggregates,
  computedAt: string,
  emittedEventId: string | null,
): void {
  db.prepare(`
    INSERT INTO daily_rollups (
      asin, date, snapshot_count,
      buybox_median_cents, buybox_min_cents, buybox_max_cents,
      lowest_new_median_cents, lowest_fba_median_cents,
      offer_count_median, fba_offer_count_median,
      sales_rank_median, sales_rank_min, sales_rank_max,
      rank_category, estimated_sales, emitted_event_id, computed_at
    ) VALUES (
      @asin, @date, @snapshotCount,
      @buyboxMedianCents, @buyboxMinCents, @buyboxMaxCents,
      @lowestNewMedianCents, @lowestFbaMedianCents,
      @offerCountMedian, @fbaOfferCountMedian,
      @salesRankMedian, @salesRankMin, @salesRankMax,
      @rankCategory, @estimatedSales, @emittedEventId, @computedAt
    )
    ON CONFLICT(asin, date) DO UPDATE SET
      snapshot_count = excluded.snapshot_count,
      buybox_median_cents = excluded.buybox_median_cents,
      buybox_min_cents = excluded.buybox_min_cents,
      buybox_max_cents = excluded.buybox_max_cents,
      lowest_new_median_cents = excluded.lowest_new_median_cents,
      lowest_fba_median_cents = excluded.lowest_fba_median_cents,
      offer_count_median = excluded.offer_count_median,
      fba_offer_count_median = excluded.fba_offer_count_median,
      sales_rank_median = excluded.sales_rank_median,
      sales_rank_min = excluded.sales_rank_min,
      sales_rank_max = excluded.sales_rank_max,
      rank_category = excluded.rank_category,
      estimated_sales = excluded.estimated_sales,
      emitted_event_id = COALESCE(daily_rollups.emitted_event_id, excluded.emitted_event_id),
      computed_at = excluded.computed_at
  `).run({
    asin,
    date: dateStr,
    snapshotCount: agg.snapshotCount,
    buyboxMedianCents: agg.buyboxMedianCents,
    buyboxMinCents: agg.buyboxMinCents,
    buyboxMaxCents: agg.buyboxMaxCents,
    lowestNewMedianCents: agg.lowestNewMedianCents,
    lowestFbaMedianCents: agg.lowestFbaMedianCents,
    offerCountMedian: agg.offerCountMedian,
    fbaOfferCountMedian: agg.fbaOfferCountMedian,
    salesRankMedian: agg.salesRankMedian,
    salesRankMin: agg.salesRankMin,
    salesRankMax: agg.salesRankMax,
    rankCategory: agg.rankCategory,
    estimatedSales: agg.estimatedSales,
    emittedEventId,
    computedAt,
  })
}

function buildDailyPayload(
  productId: string,
  dateStr: string,
  agg: Aggregates,
): Record<string, unknown> {
  return {
    productId,
    date: dateStr,
    snapshotCount: agg.snapshotCount,
    buyBoxMedian: centsToMoneyOrNull(agg.buyboxMedianCents),
    buyBoxMin: centsToMoneyOrNull(agg.buyboxMinCents),
    buyBoxMax: centsToMoneyOrNull(agg.buyboxMaxCents),
    lowestNewMedian: centsToMoneyOrNull(agg.lowestNewMedianCents),
    lowestFbaMedian: centsToMoneyOrNull(agg.lowestFbaMedianCents),
    offerCountMedian: agg.offerCountMedian,
    fbaOfferCountMedian: agg.fbaOfferCountMedian,
    salesRankMedian: agg.salesRankMedian,
    salesRankMin: agg.salesRankMin,
    salesRankMax: agg.salesRankMax,
    rankCategory: agg.rankCategory,
    estimatedSales: agg.estimatedSales,
  }
}

/**
 * Compute daily rollups for all active products over every completed UTC day
 * that has snapshots. Emits history.market.daily.v1 when config + mapping exist
 * and the row has not yet emitted.
 */
export function computeDailyRollups(
  db: DatabaseHandle,
  config: HubConfig | null,
  options: RollupOptions = {},
): RollupResult {
  const now = options.now ?? new Date()
  const lastCompleted = completedDaysUpTo(now)
  const computedAt = now.toISOString()
  const result: RollupResult = {
    products: 0,
    daysComputed: 0,
    daysEmitted: 0,
    daysSkippedExisting: 0,
  }

  const products = listProducts(db, true)
  for (const product of products) {
    result.products++
    const days = daysWithSnapshots(db, product.asin, lastCompleted)
    for (const dateStr of days) {
      const existing = getExistingRollup(db, product.asin, dateStr)
      if (existing?.emitted_event_id) {
        result.daysSkippedExisting++
        continue
      }

      const rows = loadDaySnapshots(db, product.asin, dateStr)
      // Zero-snapshot guard (should not happen given daysWithSnapshots, but §2).
      if (rows.length === 0) continue

      const agg = aggregateDay(db, product.asin, dateStr, rows)
      const mapping = getMappingByAsin(db, product.asin)
      const canEmit = config !== null && mapping !== undefined

      db.transaction(() => {
        // Upsert aggregates first (standalone or not). Preserve any existing
        // emitted_event_id via COALESCE in the upsert.
        upsertRollup(db, product.asin, dateStr, agg, computedAt, null)
        result.daysComputed++

        if (!canEmit || !config || !mapping) return

        // Re-check after upsert: may have been set by a concurrent path, or
        // this is a standalone-era row that still needs its first emit.
        const row = getExistingRollup(db, product.asin, dateStr)
        if (row?.emitted_event_id) return

        const payload = buildDailyPayload(mapping.canonicalProductId, dateStr, agg)
        const envelope = buildHistoryEvent({
          config,
          type: 'history.market.daily.v1',
          productId: mapping.canonicalProductId,
          // Occurred at end of the completed day (start of D+1).
          occurredAt: dayBounds(dateStr).end,
          payload,
        })
        enqueueOutboxEvent(db, {
          eventId: envelope.eventId,
          eventType: envelope.eventType,
          envelope: JSON.stringify(envelope),
        })
        db.prepare(`
          UPDATE daily_rollups SET emitted_event_id = ?
          WHERE asin = ? AND date = ?
        `).run(envelope.eventId, product.asin, dateStr)
        result.daysEmitted++
      })()
    }
  }

  return result
}
