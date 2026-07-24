// Ceiling / floorContext / amazonPresence analysis library
// (KEEPA-BACKFILL.md K6.1–K6.3). Pure functions — no DB writes, reads only.
//
// All money values are integer cents. All times are epoch milliseconds
// internally; ISO-8601 UTC strings at the boundary.

import type { DatabaseHandle } from '../db/schema.js'
import { dollarsToCents } from '../platform/money.js'

/** The only two Keepa metrics ceiling/floorContext/amazonPresence consume. */
export type ExtremeMetric = 'buybox' | 'amazon'

export type SegmentSource = 'keepa' | 'sweep'

/** A step-function interval [startMs, endMs) → valueCents (null = GAP). */
export interface MergedSegment {
  startMs: number
  endMs: number
  valueCents: number | null
  source: SegmentSource
}

export interface BuildMergedSegmentsOptions {
  now?: Date
  /** Sweep cadence in minutes (Settings.sweepIntervalMin). Default 60. */
  sweepIntervalMin?: number
}

// --- small numeric helpers -------------------------------------------------

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

/** Merge (sort + coalesce overlapping/adjacent) closed intervals [s, e]. */
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [[sorted[0]![0], sorted[0]![1]]]
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i]!
    const last = merged[merged.length - 1]!
    if (s <= last[1]) {
      last[1] = Math.max(last[1], e)
    } else {
      merged.push([s, e])
    }
  }
  return merged
}

/**
 * True if t falls within any coverage interval, evaluated half-open [s, e)
 * to match the half-open [startMs, endMs) semantics of the slice this
 * point is standing in for (the covering predicate itself is defined
 * closed per K6.1, but only a single zero-duration instant differs —
 * treating it as covering the FORWARD slice would wrongly attribute an
 * entire non-covered slice to sweep). Binary search.
 */
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

/** Find the segment containing t (half-open [startMs, endMs)). Binary search. */
function findSegment<T extends { startMs: number; endMs: number }>(
  segs: T[],
  t: number,
): T | undefined {
  let lo = 0
  let hi = segs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const seg = segs[mid]!
    if (t < seg.startMs) hi = mid - 1
    else if (t >= seg.endMs) lo = mid + 1
    else return seg
  }
  return undefined
}

/** Clip segments to [windowStartMs, windowEndMs), dropping non-overlapping ones. */
export function clipSegmentsToWindow(
  segments: MergedSegment[],
  windowStartMs: number,
  windowEndMs: number,
): MergedSegment[] {
  const out: MergedSegment[] = []
  for (const s of segments) {
    const startMs = Math.max(s.startMs, windowStartMs)
    const endMs = Math.min(s.endMs, windowEndMs)
    if (endMs > startMs) {
      out.push({ ...s, startMs, endMs })
    }
  }
  return out
}

// --- data access -------------------------------------------------------

interface KeepaPointRow {
  ts: string
  value: number
}

function loadKeepaPoints(
  db: DatabaseHandle,
  asin: string,
  metric: string,
): Array<{ tsMs: number; value: number }> {
  const rows = db.prepare(`
    SELECT ts, value FROM keepa_points WHERE asin = ? AND metric = ? ORDER BY ts ASC
  `).all(asin, metric) as KeepaPointRow[]
  return rows.map((r) => ({ tsMs: Date.parse(r.ts), value: r.value }))
}

interface SweepRow {
  ts: string
  buyBoxPrice: number | null
}

function loadSweepRows(
  db: DatabaseHandle,
  asin: string,
): Array<{ tsMs: number; cents: number | null }> {
  const rows = db.prepare(`
    SELECT ts, buyBoxPrice FROM snapshots WHERE asin = ? ORDER BY ts ASC, id ASC
  `).all(asin) as SweepRow[]
  return rows.map((r) => ({ tsMs: Date.parse(r.ts), cents: dollarsToCents(r.buyBoxPrice) }))
}

function firstKeepaPointMs(db: DatabaseHandle, asin: string, metric: string): number | null {
  const row = db.prepare(`
    SELECT MIN(ts) AS minTs FROM keepa_points WHERE asin = ? AND metric = ?
  `).get(asin, metric) as { minTs: string | null }
  return row.minTs ? Date.parse(row.minTs) : null
}

// --- K6.1 merged provenance step-series -------------------------------

/**
 * Build the merged (Keepa ∪ sweep, coverage-mask) step-series for one
 * metric, in cents, from [earliest observed] to `now` (KEEPA-BACKFILL.md
 * K6.1). Sweep only exists for the `buybox` metric (snapshots.buyBoxPrice);
 * `amazon` has no comparable sweep column, so it is always pure-Keepa.
 *
 * - Keepa: consecutive keepa_points define segments; a segment whose START
 *   point is -1 is a GAP (valueCents: null).
 * - Sweep (buybox only): consecutive snapshots define segments; NULL
 *   buyBoxPrice is a GAP. The final segment holds through `now`.
 * - Coverage mask: sweepCovered(t) = a sweep row exists within [t-Δ, t],
 *   Δ = 2×sweepIntervalMin. Covered time uses sweep; elsewhere uses Keepa.
 *   This makes any sweep outage exceeding Δ fall back to Keepa automatically.
 * - Guard band: the final (successor-less) Keepa segment is capped at
 *   min(sweepStart, now, lastObs + min(7d, medianInterSampleGap)) so a dead
 *   Keepa series never forward-fills its last value indefinitely.
 */
export function buildMergedSegments(
  db: DatabaseHandle,
  asin: string,
  metric: ExtremeMetric,
  options: BuildMergedSegmentsOptions = {},
): MergedSegment[] {
  const nowMs = (options.now ?? new Date()).getTime()
  const sweepIntervalMin = Math.max(1, options.sweepIntervalMin ?? 60)
  const deltaMs = 2 * sweepIntervalMin * 60_000

  const keepaPoints = loadKeepaPoints(db, asin, metric)
  const sweepRows = metric === 'buybox' ? loadSweepRows(db, asin) : []
  const sweepStartMs = sweepRows.length > 0 ? sweepRows[0]!.tsMs : undefined
  const cap7d = 7 * 86_400_000

  const keepaSegs: MergedSegment[] = []
  for (let i = 0; i < keepaPoints.length; i += 1) {
    const cur = keepaPoints[i]!
    const valueCents = cur.value === -1 ? null : cur.value
    let endMs: number
    if (i + 1 < keepaPoints.length) {
      endMs = keepaPoints[i + 1]!.tsMs
    } else {
      const gaps: number[] = []
      for (let j = 1; j < keepaPoints.length; j += 1) {
        gaps.push(keepaPoints[j]!.tsMs - keepaPoints[j - 1]!.tsMs)
      }
      const medianGap = median(gaps) ?? 0
      const guardExtension = Math.min(cap7d, medianGap)
      const candidates = [nowMs, cur.tsMs + guardExtension]
      if (sweepStartMs !== undefined) candidates.push(sweepStartMs)
      endMs = Math.max(cur.tsMs, Math.min(...candidates))
    }
    if (endMs > cur.tsMs) {
      keepaSegs.push({ startMs: cur.tsMs, endMs, valueCents, source: 'keepa' })
    }
  }

  const sweepSegs: MergedSegment[] = []
  for (let i = 0; i < sweepRows.length; i += 1) {
    const cur = sweepRows[i]!
    const endMs = i + 1 < sweepRows.length ? sweepRows[i + 1]!.tsMs : nowMs
    if (endMs > cur.tsMs) {
      sweepSegs.push({ startMs: cur.tsMs, endMs, valueCents: cur.cents, source: 'sweep' })
    }
  }

  if (keepaSegs.length === 0 && sweepSegs.length === 0) return []

  const coverage = mergeIntervals(
    sweepRows.map((r) => [r.tsMs, r.tsMs + deltaMs] as [number, number]),
  )

  const minTs = Math.min(
    keepaSegs.length > 0 ? keepaSegs[0]!.startMs : Infinity,
    sweepSegs.length > 0 ? sweepSegs[0]!.startMs : Infinity,
  )

  const breakSet = new Set<number>([minTs, nowMs])
  for (const s of keepaSegs) {
    breakSet.add(s.startMs)
    breakSet.add(s.endMs)
  }
  for (const s of sweepSegs) {
    breakSet.add(s.startMs)
    breakSet.add(s.endMs)
  }
  for (const [s, e] of coverage) {
    breakSet.add(s)
    breakSet.add(e)
  }

  const breaks = [...breakSet].filter((t) => t >= minTs && t <= nowMs).sort((a, b) => a - b)

  const result: MergedSegment[] = []
  for (let i = 0; i + 1 < breaks.length; i += 1) {
    const startMs = breaks[i]!
    const endMs = breaks[i + 1]!
    if (endMs <= startMs) continue
    const covered = isCovered(coverage, startMs)
    const seg = covered ? findSegment(sweepSegs, startMs) : findSegment(keepaSegs, startMs)
    if (!seg) continue
    const last = result[result.length - 1]
    if (
      last
      && last.source === seg.source
      && last.valueCents === seg.valueCents
      && last.endMs === startMs
    ) {
      last.endMs = endMs
    } else {
      result.push({ startMs, endMs, valueCents: seg.valueCents, source: seg.source })
    }
  }
  return result
}

export interface ObservationSummary {
  /** Count of real-valued (non-GAP) raw observations feeding the merge. */
  count: number
  firstMs: number | null
  lastMs: number | null
}

/**
 * Count + earliest/latest timestamp of the RAW real-valued observations
 * that feed a metric's merged series (each Keepa point not sweep-covered,
 * plus each real sweep row — mirrors buildMergedSegments' source selection
 * exactly). Deliberately independent of buildMergedSegments' own output:
 * that function collapses adjacent same-value segments for a compact step
 * series, which would silently undercount a long flat-price run (and even
 * understate its recency) if used as an observation-density/freshness
 * signal. Used by CONTRIB-CEILING-CONTRACT.md's coverage.buyboxPoints /
 * historyStart / historyEnd / confident gate.
 */
export function summarizeRealObservations(
  db: DatabaseHandle,
  asin: string,
  metric: ExtremeMetric,
  options: BuildMergedSegmentsOptions = {},
): ObservationSummary {
  const sweepIntervalMin = Math.max(1, options.sweepIntervalMin ?? 60)
  const deltaMs = 2 * sweepIntervalMin * 60_000

  const keepaPoints = loadKeepaPoints(db, asin, metric)
  const sweepRows = metric === 'buybox' ? loadSweepRows(db, asin) : []
  const coverage = mergeIntervals(
    sweepRows.map((r) => [r.tsMs, r.tsMs + deltaMs] as [number, number]),
  )

  let count = 0
  let firstMs: number | null = null
  let lastMs: number | null = null
  const observe = (tsMs: number): void => {
    count += 1
    if (firstMs === null || tsMs < firstMs) firstMs = tsMs
    if (lastMs === null || tsMs > lastMs) lastMs = tsMs
  }

  for (const p of keepaPoints) {
    if (p.value === -1) continue
    if (!isCovered(coverage, p.tsMs)) observe(p.tsMs)
  }
  for (const r of sweepRows) {
    if (r.cents !== null) observe(r.tsMs)
  }

  return { count, firstMs, lastMs }
}

// --- K6.2 sustained-extreme dwell --------------------------------------

export type ExtremeDir = 'ceiling' | 'floor'
export type Confidence = 'high' | 'low' | 'none'

export interface SustainedExtremeResult {
  valueCents: number | null
  fromIso: string | null
  untilIso: string | null
  dwellHours: number
  confidence: Confidence
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** T = clamp(0.01·windowDuration, 48h, 14d) (KEEPA-BACKFILL.md K6.2). */
export function thresholdMsFor(windowMs: number): number {
  const min = 48 * HOUR_MS
  const max = 14 * DAY_MS
  return Math.min(Math.max(0.01 * windowMs, min), max)
}

/**
 * The raw observed max (ceiling) / min (floor) real-valued price in the
 * window — no dwell threshold, just the literal extreme ever seen. Used
 * alongside sustainedExtreme as a hard bound (CONTRIB-CEILING-CONTRACT.md
 * absolute1y/absoluteAllTime): Aurora clamps its hunt cap to never exceed
 * this, regardless of what the sustained (dwell-filtered) value says.
 */
export function absoluteExtreme(
  segments: MergedSegment[],
  windowStartMs: number,
  nowMs: number,
  dir: ExtremeDir,
): number | null {
  const clipped = clipSegmentsToWindow(segments, windowStartMs, nowMs)
  const realValues = clipped
    .filter((s): s is MergedSegment & { valueCents: number } => s.valueCents !== null)
    .map((s) => s.valueCents)
  if (realValues.length === 0) return null
  return dir === 'ceiling' ? Math.max(...realValues) : Math.min(...realValues)
}

/**
 * Duration-weighted percentile of value over real-valued segments: the
 * value v such that the cumulative duration of segments with value <= v
 * (in ascending value order) first reaches fraction p of total duration.
 * Used both as the thin-history fallback and as the P99 phantom guard.
 */
export function dwellWeightedPercentile(
  segments: MergedSegment[],
  p: number,
): number | null {
  const byVal = new Map<number, number>()
  for (const s of segments) {
    if (s.valueCents === null) continue
    const dur = s.endMs - s.startMs
    byVal.set(s.valueCents, (byVal.get(s.valueCents) ?? 0) + dur)
  }
  if (byVal.size === 0) return null
  const total = [...byVal.values()].reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  const sortedVals = [...byVal.keys()].sort((a, b) => a - b)
  let cum = 0
  for (const v of sortedVals) {
    cum += byVal.get(v)!
    if (cum / total >= p) return v
  }
  return sortedVals[sortedVals.length - 1] ?? null
}

/**
 * Sustained-extreme dwell computation (KEEPA-BACKFILL.md K6.2). Walks
 * distinct observed values in `dir` order (ceiling: high→low; floor:
 * low→high), accumulating cumulative dwell of segments at-or-beyond each
 * value, and returns the first (most extreme) value whose cumulative dwell
 * reaches `thresholdMs`. Falls back to a duration-weighted percentile
 * (confidence 'low') when no value reaches threshold (thin history). A
 * ceiling result whose value exceeds 1.15× the duration-weighted P99 is
 * downgraded to confidence 'low' (phantom guard) — prefer under-claiming.
 */
export function sustainedExtreme(
  segments: MergedSegment[],
  windowStartMs: number,
  nowMs: number,
  dir: ExtremeDir,
  thresholdMs: number,
): SustainedExtremeResult {
  const clipped = clipSegmentsToWindow(segments, windowStartMs, nowMs)
  const realSegs = clipped.filter((s) => s.valueCents !== null)
  const observedMs = realSegs.reduce((sum, s) => sum + (s.endMs - s.startMs), 0)

  if (observedMs <= 0) {
    return { valueCents: null, fromIso: null, untilIso: null, dwellHours: 0, confidence: 'none' }
  }

  const byVal = new Map<number, number>()
  for (const s of realSegs) {
    const dur = s.endMs - s.startMs
    byVal.set(s.valueCents!, (byVal.get(s.valueCents!) ?? 0) + dur)
  }

  const sortedVals = [...byVal.keys()].sort((a, b) => (dir === 'ceiling' ? b - a : a - b))

  let cum = 0
  let foundValue: number | null = null
  for (const v of sortedVals) {
    cum += byVal.get(v)!
    if (cum >= thresholdMs) {
      foundValue = v
      break
    }
  }

  if (foundValue !== null) {
    const qualifying = dir === 'ceiling'
      ? realSegs.filter((s) => s.valueCents! >= foundValue!)
      : realSegs.filter((s) => s.valueCents! <= foundValue!)
    const fromMs = Math.min(...qualifying.map((s) => s.startMs))
    const untilMs = Math.max(...qualifying.map((s) => s.endMs))
    const dwellMs = qualifying.reduce((sum, s) => sum + (s.endMs - s.startMs), 0)

    let confidence: Confidence = 'high'
    if (dir === 'ceiling') {
      const p99 = dwellWeightedPercentile(realSegs, 0.99)
      if (p99 !== null && foundValue > 1.15 * p99) confidence = 'low'
    }

    return {
      valueCents: foundValue,
      fromIso: new Date(fromMs).toISOString(),
      untilIso: new Date(untilMs).toISOString(),
      dwellHours: dwellMs / HOUR_MS,
      confidence,
    }
  }

  // Thin history: no value's cumulative dwell reaches threshold.
  const percentile = dir === 'ceiling' ? 0.99 : 0.01
  const fallbackValue = dwellWeightedPercentile(realSegs, percentile)
  if (fallbackValue === null) {
    return { valueCents: null, fromIso: null, untilIso: null, dwellHours: 0, confidence: 'low' }
  }
  const matching = realSegs.filter((s) => s.valueCents === fallbackValue)
  const fromMs = Math.min(...matching.map((s) => s.startMs))
  const untilMs = Math.max(...matching.map((s) => s.endMs))
  const dwellMs = matching.reduce((sum, s) => sum + (s.endMs - s.startMs), 0)
  return {
    valueCents: fallbackValue,
    fromIso: new Date(fromMs).toISOString(),
    untilIso: new Date(untilMs).toISOString(),
    dwellHours: dwellMs / HOUR_MS,
    confidence: 'low',
  }
}

// --- provenance summary (used by ceiling/floor/amazonPresence) --------

export interface SegmentProvenance {
  sources: SegmentSource[]
  /** sweep-covered real duration / total real duration, within the window. */
  sweepFraction: number
}

export function summarizeProvenance(
  segments: MergedSegment[],
  windowStartMs: number,
  nowMs: number,
): SegmentProvenance {
  const clipped = clipSegmentsToWindow(segments, windowStartMs, nowMs)
  const real = clipped.filter((s) => s.valueCents !== null)
  const totalMs = real.reduce((sum, s) => sum + (s.endMs - s.startMs), 0)
  const sweepMs = real
    .filter((s) => s.source === 'sweep')
    .reduce((sum, s) => sum + (s.endMs - s.startMs), 0)
  const sources = [...new Set(real.map((s) => s.source))]
  return { sources, sweepFraction: totalMs > 0 ? sweepMs / totalMs : 0 }
}

// --- K6.3 amazonPresence -------------------------------------------------

export interface AmazonPresenceOptions {
  now?: Date
  sweepIntervalMin?: number
}

export interface AmazonPresenceResult {
  windowDays: number
  observedDays: number
  fraction: number | null
  confidence: Confidence
  sources: SegmentSource[]
  sweepFraction: number
}

/**
 * fraction = Σ dur(real-valued amazon segments ∩ [now-90d, now]) /
 * observedWindow, observedWindow = now - max(now-90d, firstObs). If
 * observedWindow < 90d → confidence 'low' (thin history), reporting
 * observedDays. No Keepa `amazon` history at all → confidence 'none'.
 */
export function amazonPresence(
  db: DatabaseHandle,
  asin: string,
  options: AmazonPresenceOptions = {},
): AmazonPresenceResult {
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const windowDays = 90
  const windowStartMs = nowMs - windowDays * DAY_MS

  const firstObsMs = firstKeepaPointMs(db, asin, 'amazon')
  if (firstObsMs === null) {
    return {
      windowDays, observedDays: 0, fraction: null, confidence: 'none',
      sources: [], sweepFraction: 0,
    }
  }

  const observedStartMs = Math.max(windowStartMs, firstObsMs)
  const observedWindowMs = nowMs - observedStartMs
  if (observedWindowMs <= 0) {
    return {
      windowDays, observedDays: 0, fraction: null, confidence: 'none',
      sources: [], sweepFraction: 0,
    }
  }

  const segments = buildMergedSegments(db, asin, 'amazon', {
    now, sweepIntervalMin: options.sweepIntervalMin,
  })
  const clipped = clipSegmentsToWindow(segments, observedStartMs, nowMs)
  const realMs = clipped
    .filter((s) => s.valueCents !== null)
    .reduce((sum, s) => sum + (s.endMs - s.startMs), 0)

  const provenance = summarizeProvenance(segments, observedStartMs, nowMs)

  return {
    windowDays,
    observedDays: observedWindowMs / DAY_MS,
    fraction: realMs / observedWindowMs,
    confidence: observedWindowMs < windowDays * DAY_MS ? 'low' : 'high',
    sources: provenance.sources,
    sweepFraction: provenance.sweepFraction,
  }
}
