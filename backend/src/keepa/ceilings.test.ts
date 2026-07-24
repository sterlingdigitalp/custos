import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import { computeCeilings } from './ceilings.js'

const DAY_MS = 86_400_000
const NOW = new Date('2026-07-23T00:00:00.000Z')
const NOW_MS = NOW.getTime()

function pt(db: DatabaseHandle, asin: string, tsMs: number, value: number): void {
  db.prepare(`
    INSERT INTO keepa_points (asin, metric, ts, value) VALUES (?, 'buybox', ?, ?)
  `).run(asin, new Date(tsMs).toISOString(), value)
}

describe('computeCeilings', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('(a) confident P1-like ASIN: real values + a -1 terminator, no gap inflation, sustained clamped below a brief spike', () => {
    const ASIN = 'B0CEIL0001'

    // 34 baseline observations at $50, 21 days apart, ending 21 days ago
    // (recent enough to be "confident").
    const baselineCount = 34
    for (let i = 0; i < baselineCount; i += 1) {
      const tsMs = NOW_MS - (baselineCount - i) * 21 * DAY_MS
      pt(db, ASIN, tsMs, 5_000)
    }

    // A genuine out-of-stock blip mid-history (-1 terminator + resume) —
    // must NOT count as a point and must NOT extend the surrounding $50
    // dwell across the gap.
    const gapStartMs = NOW_MS - 400 * DAY_MS
    pt(db, ASIN, gapStartMs, -1)
    pt(db, ASIN, gapStartMs + 5 * DAY_MS, 5_000)

    // A brief 1-day spike to $150 — must show up in "absolute" but must
    // NOT drag "sustained" up (too short to clear the dwell threshold).
    const spikeStartMs = NOW_MS - 100 * DAY_MS
    pt(db, ASIN, spikeStartMs, 15_000)
    pt(db, ASIN, spikeStartMs + 1 * DAY_MS, 5_000)

    const result = computeCeilings(db, ASIN, { now: NOW })

    expect(result.asin).toBe(ASIN)
    expect(result.provenance).toBe('keepa')
    expect(result.coverage.buyboxPoints).toBeGreaterThanOrEqual(30)
    expect(result.coverage.confident).toBe(true)
    expect(result.notes).toBeNull()

    // No gap inflation, and sustained <= absolute:
    expect(result.buyboxCeiling.absoluteAllTime).toEqual({ amount: '150.00', currency: 'USD' })
    expect(result.buyboxCeiling.absolute1y).toEqual({ amount: '150.00', currency: 'USD' })
    expect(result.buyboxCeiling.sustained1y).toEqual({ amount: '50.00', currency: 'USD' })
    expect(result.buyboxCeiling.sustainedAllTime).toEqual({ amount: '50.00', currency: 'USD' })
    expect(result.buyboxFloorContext.sustained1y).toEqual({ amount: '50.00', currency: 'USD' })
    expect(result.buyboxCeiling.method).toBe('sustained_dwell_v1')
  })

  it('(b) the gap case (0 buybox points) returns the exact null/none/confident:false shape', () => {
    const ASIN = 'B0GAP00001'
    // ASIN has zero keepa_points and zero snapshots — never collected.
    const result = computeCeilings(db, ASIN, { now: NOW })

    expect(result).toEqual({
      asin: ASIN,
      computedAt: NOW.toISOString(),
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
      amazonPresence90d: null,
      notes: 'keepa gap: ASIN in catalog, zero collected history; building forward from sweeps',
    })
  })

  it('(c) confident gate boundary: 29 vs 30 points', () => {
    const make = (asin: string, count: number): void => {
      for (let i = 0; i < count; i += 1) {
        // Recent, evenly spaced, well within the 90d staleness window.
        pt(db, asin, NOW_MS - (count - i) * 1 * DAY_MS, 5_000)
      }
    }

    make('B0PTS00029', 29)
    make('B0PTS00030', 30)

    const thin = computeCeilings(db, 'B0PTS00029', { now: NOW })
    const solid = computeCeilings(db, 'B0PTS00030', { now: NOW })

    expect(thin.coverage.buyboxPoints).toBe(29)
    expect(thin.coverage.confident).toBe(false)

    expect(solid.coverage.buyboxPoints).toBe(30)
    expect(solid.coverage.confident).toBe(true)
  })

  it('(c) confident gate boundary: historyEnd 89d vs 91d old', () => {
    const make = (asin: string, lastObservedDaysAgo: number): void => {
      // 40 points, comfortably over the point-count gate, ending EXACTLY
      // `lastObservedDaysAgo` days before now (i=39, the last iteration).
      for (let i = 0; i < 40; i += 1) {
        const tsMs = NOW_MS - (lastObservedDaysAgo + (39 - i) * 5) * DAY_MS
        pt(db, asin, tsMs, 5_000)
      }
    }

    make('B0FRESH089', 89)
    make('B0STALE091', 91)

    const fresh = computeCeilings(db, 'B0FRESH089', { now: NOW })
    const stale = computeCeilings(db, 'B0STALE091', { now: NOW })

    expect(fresh.coverage.buyboxPoints).toBeGreaterThanOrEqual(30)
    expect(fresh.coverage.confident).toBe(true)

    expect(stale.coverage.buyboxPoints).toBeGreaterThanOrEqual(30)
    expect(stale.coverage.confident).toBe(false)
  })

  it('(d) SHIP-BLOCKER guard: a thin sweep-only ASIN with ≥30 fresh points but a spike-riding fallback sustained1y is confident:false', () => {
    // The onboarding case: added ~2 days ago, swept hourly, no Keepa backfill.
    // 47 sweeps at $50 + one sweep that caught a transient $200 buybox spike.
    // buyboxPoints ≥ 30 AND fresh (the old point-count-only gate said
    // confident:true), but only ~48h of dwell < the ~3.65d 1y threshold →
    // sustained1y is a thin percentile fallback that lands on the $200 spike.
    // Publishing confident:true here makes Aurora cap sourcing at $200 on a
    // $50 product. The gate must reject it.
    const ASIN = 'B0THIN0001'
    const insert = db.prepare(`
      INSERT INTO snapshots (
        asin, ts, buyBoxPrice, lowestNewPrice, lowestFbaPrice,
        offerCount, fbaOfferCount, salesRank, rankCategory
      ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)
    `)
    for (let i = 0; i < 48; i += 1) {
      const tsMs = NOW_MS - (47 - i) * 3_600_000 // hourly, ending at NOW
      const price = i === 24 ? 200.0 : 50.0
      insert.run(ASIN, new Date(tsMs).toISOString(), price)
    }

    const result = computeCeilings(db, ASIN, { now: NOW, sweepIntervalMin: 60 })

    // Preconditions that would trip the OLD gate (points + freshness only):
    expect(result.coverage.buyboxPoints).toBeGreaterThanOrEqual(30)
    expect(NOW_MS - Date.parse(result.coverage.historyEnd!)).toBeLessThanOrEqual(90 * DAY_MS)
    // The raw compute IS the phantom — sustained1y rode the spike via fallback:
    expect(result.buyboxCeiling.absoluteAllTime).toEqual({ amount: '200.00', currency: 'USD' })
    expect(result.buyboxCeiling.sustained1y).toEqual({ amount: '200.00', currency: 'USD' })
    // ...so the gate is the safety mechanism: Aurora must NOT cap on it.
    expect(result.coverage.confident).toBe(false)
  })

  it('reports provenance keepa+sweep when both sources contribute real buybox data', () => {
    const ASIN = 'B0MIXED001'
    for (let i = 0; i < 40; i += 1) {
      pt(db, ASIN, NOW_MS - (400 - i * 5) * DAY_MS, 5_000)
    }
    db.prepare(`
      INSERT INTO snapshots (
        asin, ts, buyBoxPrice, lowestNewPrice, lowestFbaPrice,
        offerCount, fbaOfferCount, salesRank, rankCategory
      ) VALUES (?, ?, 12.0, NULL, NULL, NULL, NULL, NULL, NULL)
    `).run(ASIN, new Date(NOW_MS - 1 * DAY_MS).toISOString())

    const result = computeCeilings(db, ASIN, { now: NOW, sweepIntervalMin: 60 })
    expect(result.provenance).toBe('keepa+sweep')
  })
})
