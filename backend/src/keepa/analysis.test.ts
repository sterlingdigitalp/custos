import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { insertSnapshot } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import {
  amazonPresence,
  buildMergedSegments,
  sustainedExtreme,
  thresholdMsFor,
  type MergedSegment,
} from './analysis.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const NOW = new Date('2026-07-23T00:00:00.000Z')
const NOW_MS = NOW.getTime()

function seg(
  startMs: number,
  endMs: number,
  valueCents: number | null,
  source: 'keepa' | 'sweep' = 'keepa',
): MergedSegment {
  return { startMs, endMs, valueCents, source }
}

function insertKeepaPoint(
  db: DatabaseHandle,
  asin: string,
  metric: string,
  tsMs: number,
  value: number,
): void {
  db.prepare(`
    INSERT INTO keepa_points (asin, metric, ts, value) VALUES (?, ?, ?, ?)
  `).run(asin, metric, new Date(tsMs).toISOString(), value)
}

// --- thresholdMsFor: clamp(0.01*windowMs, 48h, 14d) -------------------

describe('thresholdMsFor', () => {
  it('clamps small windows up to the 48h floor', () => {
    // 90d window: 0.01*90d = 0.9d << 48h
    expect(thresholdMsFor(90 * DAY_MS)).toBe(48 * HOUR_MS)
  })

  it('is exactly at the 48h floor at the boundary window (200d)', () => {
    // 0.01 * 200d = 2d = 48h exactly
    expect(thresholdMsFor(200 * DAY_MS)).toBe(48 * HOUR_MS)
  })

  it('returns the unclamped 1% for a mid-size window (1y ~ 3.65d)', () => {
    const windowMs = 365 * DAY_MS
    expect(thresholdMsFor(windowMs)).toBeCloseTo(0.01 * windowMs, 6)
    expect(thresholdMsFor(windowMs) / HOUR_MS).toBeCloseTo(87.6, 1)
  })

  it('is exactly at the 14d ceiling at the boundary window (1400d)', () => {
    // 0.01 * 1400d = 14d exactly
    expect(thresholdMsFor(1_400 * DAY_MS)).toBe(14 * DAY_MS)
  })

  it('clamps large windows down to the 14d ceiling', () => {
    // all-time window, e.g. 14 years
    expect(thresholdMsFor(14 * 365 * DAY_MS)).toBe(14 * DAY_MS)
  })
})

// --- sustainedExtreme: THE PHANTOM CASE + floor mirror + fallbacks ----

describe('sustainedExtreme', () => {
  it('THE PHANTOM CASE: a brief high spike must NEVER outrank a genuinely sustained lower price', () => {
    // $200 held 1 day, then a -1 terminator (GAP), then a 25-day gap,
    // then $80 held for 60 days. ceiling(1y) must be $80 (8000 cents),
    // never $200 (20000 cents) — a 1-day spike cannot satisfy the
    // sustained-dwell threshold on its own.
    const start1 = NOW_MS - 100 * DAY_MS
    const end1 = start1 + 1 * DAY_MS // $200 for 1 day
    const end2 = end1 + 25 * DAY_MS // GAP for 25 days (the -1 terminator's span)
    const end3 = end2 + 60 * DAY_MS // $80 for 60 days

    const segments: MergedSegment[] = [
      seg(start1, end1, 20_000),
      seg(end1, end2, null), // GAP from the -1 terminator
      seg(end2, end3, 8_000),
    ]

    const windowStartMs = NOW_MS - 365 * DAY_MS
    const thresholdMs = thresholdMsFor(365 * DAY_MS)

    const result = sustainedExtreme(segments, windowStartMs, NOW_MS, 'ceiling', thresholdMs)

    expect(result.valueCents).toBe(8_000)
    // The load-bearing assertion: never the phantom high.
    expect(result.valueCents).not.toBe(20_000)
    expect(result.confidence).toBe('high')
    expect(result.dwellHours).toBeCloseTo(61 * 24, 6) // 1 + 60 days of qualifying dwell
    expect(result.fromIso).toBe(new Date(start1).toISOString())
    expect(result.untilIso).toBe(new Date(end3).toISOString())
  })

  it('a genuine 3-week hold two years ago appears in allTime ceiling, absent from 1y', () => {
    const holdStart = NOW_MS - 730 * DAY_MS
    const holdEnd = holdStart + 21 * DAY_MS // 21-day hold at $150, ~2 years ago
    const recentStart = NOW_MS - 100 * DAY_MS
    const recentEnd = NOW_MS // 100 days recent at $50

    const segments: MergedSegment[] = [
      seg(holdStart, holdEnd, 15_000),
      seg(recentStart, recentEnd, 5_000),
    ]

    // Trailing 1y: the 2-year-old hold is entirely outside the window.
    const window1yStart = NOW_MS - 365 * DAY_MS
    const threshold1y = thresholdMsFor(365 * DAY_MS)
    const ceiling1y = sustainedExtreme(segments, window1yStart, NOW_MS, 'ceiling', threshold1y)
    expect(ceiling1y.valueCents).toBe(5_000)
    expect(ceiling1y.valueCents).not.toBe(15_000)

    // All-time: the hold is included, and 21 days alone clears the 14d cap.
    const windowAllTimeStart = holdStart - 10 * DAY_MS
    const thresholdAllTime = thresholdMsFor(NOW_MS - windowAllTimeStart)
    // windowMs ~= 740d → 1% = 7.4d (below the 14d cap, still well under the
    // 21-day hold) — the hold qualifies on its own either way.
    expect(thresholdAllTime).toBeLessThan(21 * DAY_MS)
    const ceilingAllTime = sustainedExtreme(
      segments, windowAllTimeStart, NOW_MS, 'ceiling', thresholdAllTime,
    )
    expect(ceilingAllTime.valueCents).toBe(15_000)
    expect(ceilingAllTime.confidence).toBe('high')
    expect(ceilingAllTime.dwellHours).toBeCloseTo(21 * 24, 6)
  })

  it('floor mirror: a brief 1-day dip must not outrank a sustained baseline low', () => {
    const start1 = NOW_MS - 100 * DAY_MS
    const end1 = start1 + 60 * DAY_MS // $80 for 60 days (baseline)
    const end2 = end1 + 25 * DAY_MS // GAP for 25 days
    const end3 = end2 + 1 * DAY_MS // $20 for 1 day (brief dip)

    const segments: MergedSegment[] = [
      seg(start1, end1, 8_000),
      seg(end1, end2, null),
      seg(end2, end3, 2_000),
    ]

    const windowStartMs = NOW_MS - 365 * DAY_MS
    const thresholdMs = thresholdMsFor(365 * DAY_MS)
    const result = sustainedExtreme(segments, windowStartMs, NOW_MS, 'floor', thresholdMs)

    expect(result.valueCents).toBe(8_000)
    expect(result.valueCents).not.toBe(2_000)
    expect(result.confidence).toBe('high')
  })

  it('phantom guard: a threshold-qualifying value that is a rare outlier (>1.15x P99) is downgraded to low confidence', () => {
    const baselineDays = 2_100
    const holdDays = 21
    const baselineStart = NOW_MS - (baselineDays + holdDays + 10) * DAY_MS
    const baselineEnd = baselineStart + baselineDays * DAY_MS
    const holdEnd = baselineEnd + holdDays * DAY_MS

    const segments: MergedSegment[] = [
      seg(baselineStart, baselineEnd, 5_000), // years of $50
      seg(baselineEnd, holdEnd, 15_000), // genuine 21-day hold at $150
    ]

    const windowStartMs = baselineStart
    const thresholdMs = thresholdMsFor(NOW_MS - windowStartMs)
    expect(thresholdMs).toBe(14 * DAY_MS) // confirms the 14d cap (so 21d alone qualifies)

    const result = sustainedExtreme(segments, windowStartMs, NOW_MS, 'ceiling', thresholdMs)
    // The 21-day hold independently clears the dwell threshold...
    expect(result.valueCents).toBe(15_000)
    // ...but it's <1% of total observed history, so P99 guard fires.
    expect(result.confidence).toBe('low')
  })

  it('thin history: no value reaches the threshold alone → duration-weighted percentile fallback, confidence low', () => {
    const t0 = NOW_MS - 10 * HOUR_MS
    const t1 = t0 + 1 * HOUR_MS
    const t2 = t1 + 1 * HOUR_MS

    const segments: MergedSegment[] = [
      seg(t0, t1, 5_000),
      seg(t1, t2, 6_000),
    ]

    const windowStartMs = NOW_MS - 1 * DAY_MS
    const thresholdMs = thresholdMsFor(1 * DAY_MS) // clamps to 48h floor
    expect(thresholdMs).toBe(48 * HOUR_MS)

    // Total observed (2h) is far below the 48h threshold — no value can
    // reach it, even accumulating everything.
    const result = sustainedExtreme(segments, windowStartMs, NOW_MS, 'ceiling', thresholdMs)
    expect(result.confidence).toBe('low')
    expect(result.valueCents).toBe(6_000) // duration-weighted P99 of a 2-value series
    expect(result.dwellHours).toBeCloseTo(1, 6)
  })

  it('empty segments (no history at all) → confidence none, null value', () => {
    const windowStartMs = NOW_MS - 365 * DAY_MS
    const thresholdMs = thresholdMsFor(365 * DAY_MS)
    const result = sustainedExtreme([], windowStartMs, NOW_MS, 'ceiling', thresholdMs)
    expect(result).toEqual({
      valueCents: null,
      fromIso: null,
      untilIso: null,
      dwellHours: 0,
      confidence: 'none',
    })
  })

  it('GAP-only segments in window → confidence none (no real-valued observation)', () => {
    const windowStartMs = NOW_MS - 365 * DAY_MS
    const thresholdMs = thresholdMsFor(365 * DAY_MS)
    const segments: MergedSegment[] = [seg(windowStartMs, NOW_MS, null)]
    const result = sustainedExtreme(segments, windowStartMs, NOW_MS, 'ceiling', thresholdMs)
    expect(result.confidence).toBe('none')
    expect(result.valueCents).toBeNull()
  })
})

// --- buildMergedSegments: guard band + coverage-mask merge ------------

describe('buildMergedSegments', () => {
  let db: DatabaseHandle
  const ASIN = 'B0ANALYSIS1'

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('pure-Keepa: builds real/GAP segments and caps the final dangling segment via the guard band (min 7d)', () => {
    const t0 = NOW_MS - 100 * DAY_MS
    const t1 = t0 + 2 * DAY_MS
    const t2 = t1 + 3 * DAY_MS // last point, real value, no successor

    insertKeepaPoint(db, ASIN, 'buybox', t0, 5_000)
    insertKeepaPoint(db, ASIN, 'buybox', t1, -1)
    insertKeepaPoint(db, ASIN, 'buybox', t2, 6_000)

    // 'now' far in the future so it never limits the guard band.
    const farNow = new Date(t2 + 60 * DAY_MS)
    const segments = buildMergedSegments(db, ASIN, 'buybox', { now: farNow })

    expect(segments).toEqual([
      seg(t0, t1, 5_000),
      seg(t1, t2, null),
      // guard band: medianGap([2d,3d]) = 2.5d; min(7d, 2.5d) = 2.5d
      seg(t2, t2 + 2.5 * DAY_MS, 6_000),
    ])
  })

  it('caps the guard-band extension at 7 days even when the median inter-sample gap is larger', () => {
    const t0 = NOW_MS - 100 * DAY_MS
    const t1 = t0 + 10 * DAY_MS // last point, gap of 10 days to get here

    insertKeepaPoint(db, ASIN, 'buybox', t0, 4_000)
    insertKeepaPoint(db, ASIN, 'buybox', t1, 4_500)

    const farNow = new Date(t1 + 60 * DAY_MS)
    const segments = buildMergedSegments(db, ASIN, 'buybox', { now: farNow })

    expect(segments).toEqual([
      seg(t0, t1, 4_000),
      seg(t1, t1 + 7 * DAY_MS, 4_500), // capped at 7d, not the 10d median gap
    ])
  })

  it('coverage-mask merge: a sweep outage exceeding the coverage delta falls back to Keepa automatically', () => {
    // sweepIntervalMin=60 → delta = 2h coverage padding per sweep row.
    const sweepIntervalMin = 60

    // Keepa: wide historical coverage, with DIFFERENT values than sweep so
    // the source used at each moment is unambiguous from the value alone.
    insertKeepaPoint(db, ASIN, 'buybox', NOW_MS - 24 * HOUR_MS, 9_000)
    insertKeepaPoint(db, ASIN, 'buybox', NOW_MS - 7 * HOUR_MS, 9_500)
    insertKeepaPoint(db, ASIN, 'buybox', NOW_MS - 1 * HOUR_MS, 9_900)

    // Sweep: rows at -10h,-9h,-8h (chain of 2h coverage), OUTAGE from -8h to
    // -3h (5h gap, exceeds the 2h delta bridge on either side), then rows
    // resume at -3h,-2h.
    insertSnapshot(db, {
      asin: ASIN, ts: new Date(NOW_MS - 10 * HOUR_MS).toISOString(),
      buyBoxPrice: 10.0, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: null, fbaOfferCount: null, salesRank: null, rankCategory: null,
    })
    insertSnapshot(db, {
      asin: ASIN, ts: new Date(NOW_MS - 9 * HOUR_MS).toISOString(),
      buyBoxPrice: 10.0, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: null, fbaOfferCount: null, salesRank: null, rankCategory: null,
    })
    insertSnapshot(db, {
      asin: ASIN, ts: new Date(NOW_MS - 8 * HOUR_MS).toISOString(),
      buyBoxPrice: 10.0, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: null, fbaOfferCount: null, salesRank: null, rankCategory: null,
    })
    insertSnapshot(db, {
      asin: ASIN, ts: new Date(NOW_MS - 3 * HOUR_MS).toISOString(),
      buyBoxPrice: 12.0, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: null, fbaOfferCount: null, salesRank: null, rankCategory: null,
    })
    insertSnapshot(db, {
      asin: ASIN, ts: new Date(NOW_MS - 2 * HOUR_MS).toISOString(),
      buyBoxPrice: 12.0, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: null, fbaOfferCount: null, salesRank: null, rankCategory: null,
    })

    const segments = buildMergedSegments(db, ASIN, 'buybox', { now: NOW, sweepIntervalMin })

    expect(segments).toEqual([
      seg(NOW_MS - 24 * HOUR_MS, NOW_MS - 10 * HOUR_MS, 9_000, 'keepa'),
      seg(NOW_MS - 10 * HOUR_MS, NOW_MS - 6 * HOUR_MS, 1_000, 'sweep'),
      // The outage: sweep coverage lapses (delta padding runs out at -6h,
      // resumes at -3h) — this window MUST use Keepa's real value (9500),
      // never sweep's stale 1000-cents hold-forward.
      seg(NOW_MS - 6 * HOUR_MS, NOW_MS - 3 * HOUR_MS, 9_500, 'keepa'),
      seg(NOW_MS - 3 * HOUR_MS, NOW_MS, 1_200, 'sweep'),
    ])
  })

  it('returns an empty array when there is no Keepa or sweep data for the ASIN', () => {
    expect(buildMergedSegments(db, ASIN, 'buybox', { now: NOW })).toEqual([])
    expect(buildMergedSegments(db, ASIN, 'amazon', { now: NOW })).toEqual([])
  })
})

// --- amazonPresence -----------------------------------------------------

describe('amazonPresence', () => {
  let db: DatabaseHandle
  const ASIN = 'B0PRESENCE1'

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('computes fraction over a known in-stock/out-of-stock series spanning the full 90d window', () => {
    // Establish firstObs well before the 90d window so observedWindow = 90d.
    insertKeepaPoint(db, ASIN, 'amazon', NOW_MS - 200 * DAY_MS, 5_000)
    // In stock for 63 days starting exactly at the window boundary...
    insertKeepaPoint(db, ASIN, 'amazon', NOW_MS - 90 * DAY_MS, 5_000)
    // ...then out of stock (-1) for the remaining 27 days to now.
    insertKeepaPoint(db, ASIN, 'amazon', NOW_MS - 27 * DAY_MS, -1)

    const result = amazonPresence(db, ASIN, { now: NOW })

    expect(result.windowDays).toBe(90)
    expect(result.observedDays).toBeCloseTo(90, 6)
    expect(result.fraction).toBeCloseTo(63 / 90, 6)
    expect(result.confidence).toBe('high')
    expect(result.sources).toEqual(['keepa'])
    expect(result.sweepFraction).toBe(0)
  })

  it('empty history (no amazon keepa_points at all) → confidence none, null fraction', () => {
    const result = amazonPresence(db, ASIN, { now: NOW })
    expect(result).toEqual({
      windowDays: 90,
      observedDays: 0,
      fraction: null,
      confidence: 'none',
      sources: [],
      sweepFraction: 0,
    })
  })

  it('thin history (<90d observed) → confidence low, reports observedDays', () => {
    // First observation only 30 days ago.
    insertKeepaPoint(db, ASIN, 'amazon', NOW_MS - 30 * DAY_MS, 5_000)
    insertKeepaPoint(db, ASIN, 'amazon', NOW_MS - 20 * DAY_MS, -1)

    const result = amazonPresence(db, ASIN, { now: NOW })

    expect(result.observedDays).toBeCloseTo(30, 6)
    expect(result.confidence).toBe('low')
    expect(result.fraction).toBeCloseTo(10 / 30, 6)
  })
})
