// Documented-ceiling contract for Aurora (CONTRIB-CEILING-CONTRACT.md,
// frozen 2026-07-24 — do not change field names/shape without coordinating
// with the Aurora session). Computes on read from Part B's merged buybox
// series, so the live endpoint and the keepa_stats materialized cache
// (scripts/keepa-ceilings-materialize.mjs) call this same function and can
// never diverge.

import { type Money } from '@platform/contract'

import type { DatabaseHandle } from '../db/schema.js'
import { centsToMoney } from '../platform/money.js'
import {
  absoluteExtreme,
  amazonPresence,
  buildMergedSegments,
  summarizeRealObservations,
  sustainedExtreme,
  thresholdMsFor,
  type MergedSegment,
} from './analysis.js'

export type CeilingProvenance = 'keepa' | 'sweep' | 'keepa+sweep' | 'none'

export interface CeilingsOptions {
  now?: Date
  sweepIntervalMin?: number
}

export interface CeilingsResult {
  asin: string
  computedAt: string
  provenance: CeilingProvenance
  coverage: {
    historyStart: string | null
    historyEnd: string | null
    buyboxPoints: number
    confident: boolean
  }
  buyboxCeiling: {
    method: 'sustained_dwell_v1'
    sustained1y: Money | null
    sustainedAllTime: Money | null
    absolute1y: Money | null
    absoluteAllTime: Money | null
  }
  buyboxFloorContext: {
    sustained1y: Money | null
  }
  amazonPresence90d: number | null
  notes: string | null
}

const DAY_MS = 86_400_000
const YEAR_MS = 365 * DAY_MS

/** coverage.confident gate (CONTRIB-CEILING-CONTRACT.md — Aurora's trust gate). */
const CONFIDENT_MIN_POINTS = 30
const CONFIDENT_MAX_STALENESS_MS = 90 * DAY_MS

function moneyOrNull(cents: number | null): Money | null {
  return cents === null ? null : centsToMoney(cents)
}

function computeProvenance(realSegs: MergedSegment[]): CeilingProvenance {
  const sources = new Set(realSegs.map((s) => s.source))
  if (sources.size === 0) return 'none'
  if (sources.has('keepa') && sources.has('sweep')) return 'keepa+sweep'
  return sources.has('keepa') ? 'keepa' : 'sweep'
}

function gapResult(asin: string, computedAt: string, amazonPresence90d: number | null): CeilingsResult {
  return {
    asin,
    computedAt,
    provenance: 'none',
    coverage: { historyStart: null, historyEnd: null, buyboxPoints: 0, confident: false },
    buyboxCeiling: {
      method: 'sustained_dwell_v1',
      sustained1y: null,
      sustainedAllTime: null,
      absolute1y: null,
      absoluteAllTime: null,
    },
    buyboxFloorContext: { sustained1y: null },
    amazonPresence90d,
    notes: 'keepa gap: ASIN in catalog, zero collected history; building forward from sweeps',
  }
}

/**
 * Compute the documented buybox ceiling/floor/amazonPresence object for one
 * ASIN (CONTRIB-CEILING-CONTRACT.md). Pure read — no DB writes. Works for
 * any ASIN string, tracked or not: zero merged buybox observations always
 * produces the well-formed gap shape rather than throwing.
 */
export function computeCeilings(
  db: DatabaseHandle,
  asin: string,
  options: CeilingsOptions = {},
): CeilingsResult {
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const computedAt = now.toISOString()

  const segments = buildMergedSegments(db, asin, 'buybox', {
    now, sweepIntervalMin: options.sweepIntervalMin,
  })
  const realSegs = segments.filter(
    (s): s is MergedSegment & { valueCents: number } => s.valueCents !== null,
  )

  // Raw observation count/recency — NOT derived from `realSegs`, which
  // collapses adjacent same-value segments (a long flat-price run would
  // otherwise undercount points and understate its own recency).
  const observations = summarizeRealObservations(db, asin, 'buybox', {
    now, sweepIntervalMin: options.sweepIntervalMin,
  })
  const buyboxPoints = observations.count

  const presence = amazonPresence(db, asin, { now, sweepIntervalMin: options.sweepIntervalMin })

  if (buyboxPoints === 0) {
    return gapResult(asin, computedAt, presence.fraction)
  }

  const historyStartMs = observations.firstMs!
  const historyEndMs = observations.lastMs!

  const window1yStartMs = nowMs - YEAR_MS
  const threshold1yMs = thresholdMsFor(YEAR_MS)
  const thresholdAllTimeMs = thresholdMsFor(nowMs - historyStartMs)

  const sustained1y = sustainedExtreme(segments, window1yStartMs, nowMs, 'ceiling', threshold1yMs)
  const sustainedAllTime = sustainedExtreme(
    segments, historyStartMs, nowMs, 'ceiling', thresholdAllTimeMs,
  )
  const floor1y = sustainedExtreme(segments, window1yStartMs, nowMs, 'floor', threshold1yMs)

  const absolute1y = absoluteExtreme(segments, window1yStartMs, nowMs, 'ceiling')
  const absoluteAllTime = absoluteExtreme(segments, historyStartMs, nowMs, 'ceiling')

  // Aurora caps sourcing on sustained1y ONLY when confident:true, so the gate
  // must also require that sustained1y itself is trustworthy — not a thin-
  // history percentile fallback or a P99 phantom-guard downgrade (both set
  // sustainedExtreme confidence to 'low'; a null 1y value sets 'none'). Point
  // count + freshness alone would publish confident:true on a ~2-day sweep-only
  // ASIN whose sustained1y is a fallback riding a transient spike — the exact
  // phantom-HIGH overpay this endpoint exists to prevent. 'high' provably means
  // the value was held past the in-window dwell threshold and isn't a >1.15×P99
  // outlier. (Verified: strictly safer than Aurora's relative fallback, never
  // worse — @mind adversarial review 2026-07-24.)
  const confident = buyboxPoints >= CONFIDENT_MIN_POINTS
    && (nowMs - historyEndMs) <= CONFIDENT_MAX_STALENESS_MS
    && sustained1y.confidence === 'high'

  return {
    asin,
    computedAt,
    provenance: computeProvenance(realSegs),
    coverage: {
      historyStart: new Date(historyStartMs).toISOString(),
      historyEnd: new Date(historyEndMs).toISOString(),
      buyboxPoints,
      confident,
    },
    buyboxCeiling: {
      method: 'sustained_dwell_v1',
      sustained1y: moneyOrNull(sustained1y.valueCents),
      sustainedAllTime: moneyOrNull(sustainedAllTime.valueCents),
      absolute1y: moneyOrNull(absolute1y),
      absoluteAllTime: moneyOrNull(absoluteAllTime),
    },
    buyboxFloorContext: {
      sustained1y: moneyOrNull(floor1y.valueCents),
    },
    amazonPresence90d: presence.fraction,
    notes: null,
  }
}
