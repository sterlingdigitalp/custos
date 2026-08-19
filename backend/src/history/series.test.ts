import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { insertSnapshot, seriesForAsin, type CreateSnapshotInput, type Snapshot } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import { buildHistorySeries, DEFAULT_MAX_POINTS, MAX_MAX_POINTS } from './series.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const NOW = new Date('2026-08-19T00:00:00.000Z')
const NOW_MS = NOW.getTime()

function pt(db: DatabaseHandle, asin: string, metric: string, tsMs: number, value: number): void {
  db.prepare(`
    INSERT INTO keepa_points (asin, metric, ts, value) VALUES (?, ?, ?, ?)
  `).run(asin, metric, new Date(tsMs).toISOString(), value)
}

const BLANK: Omit<CreateSnapshotInput, 'asin' | 'ts'> = {
  buyBoxPrice: null,
  lowestNewPrice: null,
  lowestFbaPrice: null,
  offerCount: null,
  fbaOfferCount: null,
  salesRank: null,
  rankCategory: null,
}

function snap(
  db: DatabaseHandle,
  asin: string,
  tsMs: number,
  fields: Partial<Omit<CreateSnapshotInput, 'asin' | 'ts'>> = {},
): Snapshot {
  return insertSnapshot(db, { asin, ts: new Date(tsMs).toISOString(), ...BLANK, ...fields })
}

describe('buildHistorySeries (KEEPA-BACKFILL K3 blended read)', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('Keepa-only ASIN: no snapshots, returns Keepa-sourced rows with correct dollar conversion', () => {
    const ASIN = 'B0KEEPA001'
    pt(db, ASIN, 'buybox', NOW_MS - 10 * DAY_MS, 1_999) // $19.99
    pt(db, ASIN, 'buybox', NOW_MS - 5 * DAY_MS, 2_499) // $24.99
    pt(db, ASIN, 'salesrank', NOW_MS - 5 * DAY_MS, 12_345)

    const rows = buildHistorySeries(db, ASIN, { days: 365, now: NOW })

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.source === 'keepa')).toBe(true)
    const first = rows.find((r) => r.ts === new Date(NOW_MS - 10 * DAY_MS).toISOString())
    expect(first?.buyBoxPrice).toBe(19.99)
    const second = rows.find((r) => r.ts === new Date(NOW_MS - 5 * DAY_MS).toISOString())
    expect(second?.buyBoxPrice).toBe(24.99)
    expect(second?.salesRank).toBe(12_345)
  })

  it('Sweep-only ASIN: unchanged vs seriesForAsin, every row tagged source: sweep', () => {
    const ASIN = 'B0SWEEP001'
    snap(db, ASIN, NOW_MS - 4 * DAY_MS, { buyBoxPrice: 10, salesRank: 100 })
    snap(db, ASIN, NOW_MS - 3 * DAY_MS, { buyBoxPrice: 11, salesRank: 101 })
    snap(db, ASIN, NOW_MS - 2 * DAY_MS, { buyBoxPrice: 12, salesRank: 102 })

    const expected = seriesForAsin(db, ASIN, 90, NOW)
    const actual = buildHistorySeries(db, ASIN, { days: 90, now: NOW })

    expect(actual).toEqual(expected.map((row) => ({ ...row, source: 'sweep' })))
  })

  it('Overlap: sweep wins over a Keepa point at the same covered instant', () => {
    const ASIN = 'B0OVERLAP1'
    const tsMs = NOW_MS - 2 * DAY_MS
    pt(db, ASIN, 'buybox', tsMs, 9_999) // $99.99 — must lose
    snap(db, ASIN, tsMs, { buyBoxPrice: 50 }) // sweep — must win

    const rows = buildHistorySeries(db, ASIN, { days: 90, now: NOW })

    const atTs = rows.filter((r) => r.ts === new Date(tsMs).toISOString())
    expect(atTs).toHaveLength(1)
    expect(atTs[0]?.source).toBe('sweep')
    expect(atTs[0]?.buyBoxPrice).toBe(50)
  })

  it('Gap fill: the Jul-outage case — sweep before/after a multi-day hole, Keepa fills the hole', () => {
    const ASIN = 'B0GAPFILL1'
    const beforeMs = NOW_MS - 10 * DAY_MS
    const afterMs = NOW_MS - 4 * DAY_MS // 6-day hole, far beyond the 2h sweep coverage window

    snap(db, ASIN, beforeMs, { buyBoxPrice: 20 })
    snap(db, ASIN, afterMs, { buyBoxPrice: 25 })

    const insideGap1 = beforeMs + 2 * DAY_MS
    const insideGap2 = beforeMs + 4 * DAY_MS
    pt(db, ASIN, 'buybox', insideGap1, 2_100) // $21.00
    pt(db, ASIN, 'buybox', insideGap2, 2_200) // $22.00

    const rows = buildHistorySeries(db, ASIN, { days: 90, now: NOW, sweepIntervalMin: 60 })

    const byTs = new Map(rows.map((r) => [r.ts, r]))
    const before = byTs.get(new Date(beforeMs).toISOString())
    const after = byTs.get(new Date(afterMs).toISOString())
    const gap1 = byTs.get(new Date(insideGap1).toISOString())
    const gap2 = byTs.get(new Date(insideGap2).toISOString())

    expect(before?.source).toBe('sweep')
    expect(before?.buyBoxPrice).toBe(20)
    expect(after?.source).toBe('sweep')
    expect(after?.buyBoxPrice).toBe(25)
    expect(gap1?.source).toBe('keepa')
    expect(gap1?.buyBoxPrice).toBe(21)
    expect(gap2?.source).toBe('keepa')
    expect(gap2?.buyBoxPrice).toBe(22)
  })

  it('A miss row (all metrics null) neither appears as a point nor suppresses Keepa coverage', () => {
    const ASIN = 'B0MISSROW1'
    const missTsMs = NOW_MS - 5 * DAY_MS
    snap(db, ASIN, missTsMs) // every field null — a total sweep-miss row
    pt(db, ASIN, 'buybox', missTsMs, 3_000) // Keepa point at the SAME instant

    const rows = buildHistorySeries(db, ASIN, { days: 90, now: NOW })

    const atTs = rows.filter((r) => r.ts === new Date(missTsMs).toISOString())
    expect(atTs).toHaveLength(1)
    expect(atTs[0]?.source).toBe('keepa')
    expect(atTs[0]?.buyBoxPrice).toBe(30)
  })

  it('-1 Keepa terminator reads as absence, not zero', () => {
    const ASIN = 'B0TERM0001'
    const valueTsMs = NOW_MS - 8 * DAY_MS
    const terminatorTsMs = NOW_MS - 6 * DAY_MS
    pt(db, ASIN, 'buybox', valueTsMs, 1_000) // $10.00
    pt(db, ASIN, 'buybox', terminatorTsMs, -1) // becomes absent from here on

    const rows = buildHistorySeries(db, ASIN, { days: 90, now: NOW })

    const before = rows.find((r) => r.ts === new Date(valueTsMs).toISOString())
    const terminated = rows.find((r) => r.ts === new Date(terminatorTsMs).toISOString())
    expect(before?.buyBoxPrice).toBe(10)
    expect(terminated?.buyBoxPrice).toBeNull()
  })

  it('Downsampling: far more points than maxPoints yields <= maxPoints rows, ordered, last row exact', () => {
    const ASIN = 'B0DOWNS001'
    const maxPoints = 10
    const count = 100
    for (let i = 0; i < count; i += 1) {
      pt(db, ASIN, 'buybox', NOW_MS - (count - i) * HOUR_MS, 1_000 + i)
    }
    const lastTsMs = NOW_MS - HOUR_MS // i = count - 1
    const lastValue = 1_000 + (count - 1)

    const rows = buildHistorySeries(db, ASIN, { days: 10, maxPoints, now: NOW })

    expect(rows.length).toBeLessThanOrEqual(maxPoints)
    for (let i = 1; i < rows.length; i += 1) {
      expect(Date.parse(rows[i]!.ts)).toBeGreaterThan(Date.parse(rows[i - 1]!.ts))
    }
    const last = rows[rows.length - 1]!
    expect(last.ts).toBe(new Date(lastTsMs).toISOString())
    expect(last.buyBoxPrice).toBe(lastValue / 100)
    expect(last.source).toBe('keepa')
  })

  it('maxPoints validation: 0, negative, >5000, and non-integer are all rejected', () => {
    const ASIN = 'B0MAXPTS01'
    pt(db, ASIN, 'buybox', NOW_MS - DAY_MS, 1_000)
    expect(() => buildHistorySeries(db, ASIN, { days: 30, maxPoints: 0, now: NOW })).toThrow()
    expect(() => buildHistorySeries(db, ASIN, { days: 30, maxPoints: -5, now: NOW })).toThrow()
    expect(() => buildHistorySeries(db, ASIN, { days: 30, maxPoints: MAX_MAX_POINTS + 1, now: NOW })).toThrow()
    expect(() => buildHistorySeries(db, ASIN, { days: 30, maxPoints: 12.5, now: NOW })).toThrow()
    expect(DEFAULT_MAX_POINTS).toBe(800)
    expect(MAX_MAX_POINTS).toBe(5000)
  })

  it('Large-window performance sanity: 50k+ Keepa points, days=36500 ("All"), completes fast and bounded', () => {
    const ASIN = 'B0BIGASIN1'
    const pointCount = 50_000
    const startMs = NOW_MS - 15 * 365 * DAY_MS
    const stepMs = Math.floor((15 * 365 * DAY_MS) / pointCount)
    const insertMany = db.transaction(() => {
      for (let i = 0; i < pointCount; i += 1) {
        pt(db, ASIN, 'buybox', startMs + i * stepMs, 1_000 + (i % 500))
      }
    })
    insertMany()

    const startedAt = Date.now()
    const rows = buildHistorySeries(db, ASIN, { days: 36_500, now: NOW })
    const elapsedMs = Date.now() - startedAt

    expect(rows.length).toBeLessThanOrEqual(DEFAULT_MAX_POINTS)
    expect(elapsedMs).toBeLessThan(5_000)
  })
})

describe('buildHistorySeries — grid anchoring (production regression)', () => {
  let db: DatabaseHandle | undefined
  afterEach(() => db?.close())

  // Caught only by querying real production data: the UI's "All" range sends
  // days=36500, and anchoring the bucket grid at `now - days` started it in
  // 1926. ~92% of buckets predated any data (66 of 800 rows carried a price)
  // and all recent sweeps collapsed into a single bucket. The grid must span
  // the ACTUAL data range, so every bucket lands where history exists.
  it('days=36500 ("All") anchors the grid to the first real point, not now-100y', () => {
    const database = openDatabase(':memory:')
    db = database
    const ASIN = 'B0ANCHOR01'
    const firstMs = NOW_MS - 3 * 365 * DAY_MS // three years of history, nothing older

    // Dense Keepa history over those three years only.
    for (let i = 0; i < 4000; i += 1) {
      pt(database, ASIN, 'buybox', firstMs + Math.round((i / 4000) * 3 * 365 * DAY_MS), 1_000 + i)
    }

    const rows = buildHistorySeries(database, ASIN, { days: 36_500, maxPoints: 400, now: NOW })

    expect(rows.length).toBeLessThanOrEqual(400)
    // No row may predate the earliest real datum — that was the 1926 bug.
    expect(new Date(rows[0]!.ts).getTime()).toBeGreaterThanOrEqual(firstMs)
    // And the grid must be DENSE: nearly every bucket carries a real price,
    // rather than most falling into an empty prehistoric span.
    const withPrice = rows.filter((r) => r.buyBoxPrice !== null).length
    expect(withPrice).toBeGreaterThan(rows.length * 0.9)
  })
})
