// History contribution builder (PLATFORM-INTEGRATION.md §3, P3).
// Builds Contribution envelopes for GET /contrib/products|asins using only
// @platform/contract builders. Data is derived from snapshots, daily_rollups,
// and history_spikes — no invented fields.

import {
  absentContribution,
  freshContribution,
  staleContribution,
  unavailableContribution,
  type Contribution,
} from '@platform/contract'

import {
  getMappingByAsin,
  getMappingByCanonicalId,
  getSettings,
  latestSnapshotForAsin,
  type Snapshot,
} from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'
import { centsToMoneyOrNull, dollarsToCents } from './money.js'
import { integerMedian } from './rollups.js'

const SOURCE = 'history'

export interface HistoryContributionLookup {
  productId?: string
  asin?: string
}

export interface HistoryContributionOptions {
  now: Date
}

interface RollupDayRow {
  date: string
  buybox_median_cents: number | null
  buybox_min_cents: number | null
  buybox_max_cents: number | null
  sales_rank_median: number | null
  sales_rank_min: number | null
  sales_rank_max: number | null
}

function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Subtract `days` from a YYYY-MM-DD UTC date string. */
function utcDateMinusDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function maxOf(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.max(...values)
}

function minOf(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.min(...values)
}

function loadRollupsInWindow(
  db: DatabaseHandle,
  asin: string,
  startDate: string,
  endDate: string,
): RollupDayRow[] {
  return db.prepare(`
    SELECT date, buybox_median_cents, buybox_min_cents, buybox_max_cents,
           sales_rank_median, sales_rank_min, sales_rank_max
    FROM daily_rollups
    WHERE asin = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(asin, startDate, endDate) as RollupDayRow[]
}

function countSpikesInWindow(
  db: DatabaseHandle,
  asin: string,
  windowStartIso: string,
  windowEndIso: string,
): number {
  return (db.prepare(`
    SELECT COUNT(*) AS c FROM history_spikes
    WHERE asin = ? AND detected_at >= ? AND detected_at < ?
  `).get(asin, windowStartIso, windowEndIso) as { c: number }).c
}

function maxSnapshotId(db: DatabaseHandle, asin: string): number | null {
  const row = db.prepare(
    'SELECT MAX(id) AS maxId FROM snapshots WHERE asin = ?',
  ).get(asin) as { maxId: number | null }
  return row.maxId
}

function resolveAsin(
  db: DatabaseHandle,
  lookup: HistoryContributionLookup,
): string | undefined {
  if (lookup.productId !== undefined && lookup.productId !== '') {
    return getMappingByCanonicalId(db, lookup.productId)?.asin
  }
  if (lookup.asin !== undefined && lookup.asin !== '') {
    const asin = lookup.asin.trim().toUpperCase()
    // Convenience path: unmapped ASINs are absent (PLATFORM-INTEGRATION.md §3).
    if (!getMappingByAsin(db, asin)) return undefined
    return asin
  }
  return undefined
}

function buildHistoryData(
  db: DatabaseHandle,
  asin: string,
  latest: Snapshot,
  now: Date,
): Record<string, unknown> {
  const today = utcDayString(now)
  const start90 = utcDateMinusDays(today, 89)
  const start30 = utcDateMinusDays(today, 29)

  const rollups90 = loadRollupsInWindow(db, asin, start90, today)
  const rollups30 = rollups90.filter((r) => r.date >= start30)

  const buyboxMedians90 = rollups90
    .map((r) => r.buybox_median_cents)
    .filter((c): c is number => c !== null)
  const buyboxMins90 = rollups90
    .map((r) => r.buybox_min_cents)
    .filter((c): c is number => c !== null)
  const buyboxMaxs90 = rollups90
    .map((r) => r.buybox_max_cents)
    .filter((c): c is number => c !== null)

  const boxMedian90dCents = integerMedian(buyboxMedians90)

  const rankMedians30 = rollups30
    .map((r) => r.sales_rank_median)
    .filter((c): c is number => c !== null)
  const rankMins30 = rollups30
    .map((r) => r.sales_rank_min)
    .filter((c): c is number => c !== null)
  const rankMaxs30 = rollups30
    .map((r) => r.sales_rank_max)
    .filter((c): c is number => c !== null)

  const spikeWindowStart = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const spikeCount = countSpikesInWindow(db, asin, spikeWindowStart, now.toISOString())

  return {
    currentBuyBox: centsToMoneyOrNull(dollarsToCents(latest.buyBoxPrice)),
    currentRank: latest.salesRank,
    offerCount: latest.offerCount,
    fbaOfferCount: latest.fbaOfferCount,
    priceSeries: rollups90.map((r) => ({
      date: r.date,
      buyBox: centsToMoneyOrNull(r.buybox_median_cents),
    })),
    rankSeries: rollups90.map((r) => ({
      date: r.date,
      rank: r.sales_rank_median,
    })),
    // Normative §11.3 minimum — always present (may be null / 0).
    boxMedian90d: centsToMoneyOrNull(boxMedian90dCents),
    buyBox90d: {
      min: centsToMoneyOrNull(minOf(buyboxMins90)),
      max: centsToMoneyOrNull(maxOf(buyboxMaxs90)),
      median: centsToMoneyOrNull(boxMedian90dCents),
    },
    rank30d: {
      median: integerMedian(rankMedians30),
      min: minOf(rankMins30),
      max: maxOf(rankMaxs30),
    },
    estimatedSold30d: spikeCount,
    rankDrops30d: spikeCount,
    snapshotDays90d: rollups90.length,
  }
}

/**
 * Build a history Contribution for a productId (prd_) or ASIN lookup.
 * Always uses contract builders; never hand-rolls the envelope.
 */
export function buildHistoryContribution(
  db: DatabaseHandle,
  lookup: HistoryContributionLookup,
  options: HistoryContributionOptions,
): Contribution<Record<string, unknown>> {
  const { now } = options
  const asOfNow = now.toISOString()

  const asin = resolveAsin(db, lookup)
  if (!asin) {
    return absentContribution(SOURCE, asOfNow)
  }

  const latest = latestSnapshotForAsin(db, asin)
  if (!latest) {
    return unavailableContribution(SOURCE, asOfNow, 'NEVER_SYNCED')
  }

  const data = buildHistoryData(db, asin, latest, now)
  const seq = maxSnapshotId(db, asin)
  const sourceSequence = seq !== null && Number.isSafeInteger(seq) ? seq : undefined
  const asOf = latest.ts

  const settings = getSettings(db)
  const intervalMin = Math.max(1, settings.sweepIntervalMin)
  const ageMs = now.getTime() - new Date(latest.ts).getTime()
  const freshWindowMs = 2 * intervalMin * 60_000
  const isFresh = ageMs < freshWindowMs

  if (isFresh) {
    return freshContribution(SOURCE, asOf, data, sourceSequence)
  }
  return staleContribution(SOURCE, asOf, data, undefined, sourceSequence)
}
