// Blended product history (KEEPA-BACKFILL.md K3): a read-time merge of
// sweep snapshots (authoritative wherever a real sweep observation exists)
// and Keepa historical points (fill everything earlier, plus any gap in
// sweep coverage — e.g. the 2026-07-12→17 outage). Never writes Keepa data
// into `snapshots` (K1) — this module only reads.
//
// Bounded output: the natural per-ASIN event set (every real sweep
// observation, plus every Keepa point outside sweep coverage) is used
// directly when it fits within maxPoints. Once it exceeds maxPoints, we
// switch to an evenly spaced bucket grid over the window, each bucket
// resolved by binary search over each metric's ordered point array
// (O(buckets * metrics * log n)) — the ASIN's Keepa point set is loaded
// (as in keepa/analysis.ts's loadKeepaPoints), never the platform-wide
// 38M-row table. The final row is always the true latest observation,
// exact and un-bucketed (frontend treats history.at(-1) as "current").

import { OBSERVATION_SQL, type Snapshot } from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'
import type { KeepaMetric } from '../keepa/normalize.js'
import { centsToDollars } from '../platform/money.js'

export type HistorySource = 'sweep' | 'keepa'

/** Shape-compatible with Snapshot — ProductChart consumes this untouched. */
export interface HistoryRow extends Snapshot {
  source: HistorySource
}

export interface BuildHistorySeriesOptions {
  days: number
  /** Hard-bounds output row count. Default 800, ceiling 5000. */
  maxPoints?: number
  now?: Date
  /** Sweep cadence in minutes (Settings.sweepIntervalMin). Default 60. */
  sweepIntervalMin?: number
}

export const DEFAULT_MAX_POINTS = 800
export const MAX_MAX_POINTS = 5000

const DAY_MS = 86_400_000

/**
 * Synthetic id for any row that isn't a verbatim `snapshots` row (a Keepa
 * composite, or a resampled grid point). Real snapshot ids are positive
 * autoincrement values, so this never collides.
 */
const SYNTHETIC_ID = -1

interface SweepObs {
  tsMs: number
  snapshot: Snapshot
}

interface KeepaPoint {
  tsMs: number
  value: number
}

interface MetricSpec {
  metric: KeepaMetric
  field: 'buyBoxPrice' | 'lowestNewPrice' | 'lowestFbaPrice' | 'salesRank' | 'offerCount'
  money: boolean
}

/** Keepa metric → snapshot field (task spec). No Keepa source for fbaOfferCount/rankCategory. */
const METRIC_SPECS: readonly MetricSpec[] = [
  { metric: 'buybox', field: 'buyBoxPrice', money: true },
  { metric: 'new', field: 'lowestNewPrice', money: true },
  { metric: 'new_fba', field: 'lowestFbaPrice', money: true },
  { metric: 'salesrank', field: 'salesRank', money: false },
  { metric: 'offercount', field: 'offerCount', money: false },
]

function normalizeMaxPoints(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_POINTS
  if (!Number.isInteger(value) || value < 1 || value > MAX_MAX_POINTS) {
    throw new Error(`maxPoints must be an integer between 1 and ${MAX_MAX_POINTS}`)
  }
  return value
}

/**
 * Real sweep observations only (OBSERVATION_SQL — mirrors `isObservation`).
 * A miss row (every metric null) is excluded here, so it can neither appear
 * as a data point nor create sweep coverage, per KEEPA-BACKFILL K3.
 */
function loadSweepObservations(db: DatabaseHandle, asin: string): SweepObs[] {
  const rows = db.prepare(`
    SELECT * FROM snapshots WHERE asin = ? AND ${OBSERVATION_SQL} ORDER BY ts ASC, id ASC
  `).all(asin) as Snapshot[]
  return rows.map((snapshot) => ({ tsMs: Date.parse(snapshot.ts), snapshot }))
}

function loadKeepaPoints(db: DatabaseHandle, asin: string, metric: KeepaMetric): KeepaPoint[] {
  const rows = db.prepare(`
    SELECT ts, value FROM keepa_points WHERE asin = ? AND metric = ? ORDER BY ts ASC
  `).all(asin, metric) as Array<{ ts: string; value: number }>
  return rows.map((row) => ({ tsMs: Date.parse(row.ts), value: row.value }))
}

/** Merge (sort + coalesce overlapping/adjacent) half-open intervals [s, e). */
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [[sorted[0]![0], sorted[0]![1]]]
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i]!
    const last = merged[merged.length - 1]!
    if (s <= last[1]) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  return merged
}

function isCovered(coverage: Array<[number, number]>, t: number): boolean {
  let lo = 0
  let hi = coverage.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [s, e] = coverage[mid]!
    if (t < s) hi = mid - 1
    else if (t >= e) lo = mid + 1
    else return true
  }
  return false
}

/** Index of the last element with tsMs <= t, or -1 (binary search). */
function lastAtOrBefore<T extends { tsMs: number }>(arr: readonly T[], t: number): number {
  let lo = 0
  let hi = arr.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]!.tsMs <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

export function buildHistorySeries(
  db: DatabaseHandle,
  asin: string,
  options: BuildHistorySeriesOptions,
): HistoryRow[] {
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const days = Math.max(0, options.days)
  const windowStartMs = nowMs - days * DAY_MS
  const maxPoints = normalizeMaxPoints(options.maxPoints)
  const sweepIntervalMin = Math.max(1, options.sweepIntervalMin ?? 60)
  const deltaMs = 2 * sweepIntervalMin * 60_000

  const sweepObs = loadSweepObservations(db, asin)
  const coverage = mergeIntervals(sweepObs.map((r) => [r.tsMs, r.tsMs + deltaMs] as [number, number]))

  const metricPoints = new Map<KeepaMetric, KeepaPoint[]>()
  for (const spec of METRIC_SPECS) metricPoints.set(spec.metric, loadKeepaPoints(db, asin, spec.metric))

  /** Per-metric forward-filled value at tsMs; -1 terminator or "not yet seen" both read as null (absence). */
  function keepaFieldsAt(tsMs: number) {
    const fields: Record<MetricSpec['field'], number | null> = {
      buyBoxPrice: null,
      lowestNewPrice: null,
      lowestFbaPrice: null,
      salesRank: null,
      offerCount: null,
    }
    for (const spec of METRIC_SPECS) {
      const points = metricPoints.get(spec.metric)!
      const idx = lastAtOrBefore(points, tsMs)
      if (idx === -1) continue
      const raw = points[idx]!.value
      if (raw === -1) continue // gap terminator: absence, not zero
      fields[spec.field] = spec.money ? centsToDollars(raw) : raw
    }
    return fields
  }

  function keepaRow(tsMs: number): HistoryRow {
    return {
      id: SYNTHETIC_ID,
      asin,
      ts: new Date(tsMs).toISOString(),
      ...keepaFieldsAt(tsMs),
      fbaOfferCount: null, // no Keepa source for this metric
      rankCategory: null, // no Keepa source for this metric
      source: 'keepa',
    }
  }

  /** Exact row at tsMs: verbatim sweep snapshot when sweep-covered, else composed Keepa values. */
  function exactRow(tsMs: number): HistoryRow {
    if (isCovered(coverage, tsMs)) {
      const idx = lastAtOrBefore(sweepObs, tsMs)
      if (idx !== -1) return { ...sweepObs[idx]!.snapshot, source: 'sweep' }
    }
    return keepaRow(tsMs)
  }

  /** Resampled bucket-boundary row — always a synthetic id/ts, regardless of source. */
  function gridRow(tsMs: number): HistoryRow {
    if (isCovered(coverage, tsMs)) {
      const idx = lastAtOrBefore(sweepObs, tsMs)
      if (idx !== -1) {
        const snap = sweepObs[idx]!.snapshot
        return {
          id: SYNTHETIC_ID,
          asin,
          ts: new Date(tsMs).toISOString(),
          buyBoxPrice: snap.buyBoxPrice,
          lowestNewPrice: snap.lowestNewPrice,
          lowestFbaPrice: snap.lowestFbaPrice,
          offerCount: snap.offerCount,
          fbaOfferCount: snap.fbaOfferCount,
          salesRank: snap.salesRank,
          rankCategory: snap.rankCategory,
          source: 'sweep',
        }
      }
    }
    return keepaRow(tsMs)
  }

  // Natural breakpoints: every real sweep observation in-window, plus every
  // Keepa point (including -1 terminators, which mark a real transition to
  // absence) whose timestamp sweep does NOT cover. Coverage-mask idea reused
  // from keepa/analysis.ts's buildMergedSegments.
  const breakpoints = new Set<number>()
  for (const r of sweepObs) {
    if (r.tsMs >= windowStartMs) breakpoints.add(r.tsMs)
  }
  for (const spec of METRIC_SPECS) {
    for (const p of metricPoints.get(spec.metric)!) {
      if (p.tsMs < windowStartMs || p.tsMs > nowMs) continue
      if (isCovered(coverage, p.tsMs)) continue
      breakpoints.add(p.tsMs)
    }
  }
  const sortedBreaks = [...breakpoints].sort((a, b) => a - b)
  if (sortedBreaks.length === 0) return []

  if (sortedBreaks.length <= maxPoints) {
    return sortedBreaks.map((tsMs) => exactRow(tsMs))
  }

  // Downsample onto an evenly spaced grid, then append the true latest
  // observation exact and un-bucketed.
  //
  // The grid spans the ACTUAL data range (first..last breakpoint), NOT the
  // requested window. The UI's "All" range sends days=36500, so anchoring the
  // grid at `nowMs - days` put its start in 1926: ~92% of buckets landed
  // before any data existed, real points collapsed into a handful of buckets
  // (66 of 800 rows carried a price), and every recent sweep fell into one
  // bucket. Clamping to the first real breakpoint keeps all maxPoints buckets
  // inside the period that actually has history.
  const finalMs = sortedBreaks[sortedBreaks.length - 1]!
  const gridStartMs = sortedBreaks[0]!
  const bucketCount = Math.max(1, maxPoints - 1)
  const span = finalMs - gridStartMs
  const rows: HistoryRow[] = []
  let lastT = -Infinity
  for (let i = 0; i < bucketCount; i += 1) {
    const t = span <= 0 ? finalMs : gridStartMs + Math.round((i / bucketCount) * span)
    if (t >= finalMs || t <= lastT) continue
    rows.push(gridRow(t))
    lastT = t
  }
  rows.push(exactRow(finalMs))
  return rows
}
