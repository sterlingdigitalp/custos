import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  keepaMinutesToIso,
  normalizeKeepaProduct,
  type KeepaMetric,
} from './normalize.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(__dirname, 'fixtures', 'keepa-product-B00FLYWNYQ.json.gz')

function loadFixtureProduct(): {
  asin: string
  csv: Array<number[] | null>
  product: Record<string, unknown>
} {
  const raw = gunzipSync(readFileSync(FIXTURE_PATH))
  const body = JSON.parse(raw.toString('utf8')) as {
    products: Array<Record<string, unknown>>
  }
  const product = body.products[0]!
  return {
    asin: String(product.asin),
    csv: product.csv as Array<number[] | null>,
    product,
  }
}

function countByMetric(points: ReturnType<typeof normalizeKeepaProduct>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const point of points) {
    counts[point.metric] = (counts[point.metric] ?? 0) + 1
  }
  return counts
}

function firstLast(
  points: ReturnType<typeof normalizeKeepaProduct>,
  metric: KeepaMetric,
): { first?: (typeof points)[0]; last?: (typeof points)[0] } {
  const series = points.filter((p) => p.metric === metric)
  return { first: series[0], last: series[series.length - 1] }
}

describe('keepaMinutesToIso', () => {
  it('converts keepa minutes with the documented epoch offset', () => {
    // Hand-checked: 3628244 → 2017-11-24T14:44:00.000Z
    expect(keepaMinutesToIso(3_628_244)).toBe('2017-11-24T14:44:00.000Z')
    // 8180950 → 2026-07-22T05:10:00.000Z
    expect(keepaMinutesToIso(8_180_950)).toBe('2026-07-22T05:10:00.000Z')
  })
})

describe('normalizeKeepaProduct golden fixture B00FLYWNYQ', () => {
  const { asin, csv, product } = loadFixtureProduct()
  const points = normalizeKeepaProduct(product)

  it('loads the real fixture with 36 csv arrays', () => {
    expect(asin).toBe('B00FLYWNYQ')
    expect(csv).toHaveLength(36)
    // buybox (18) and new_fba (10) are empty/null in this fixture
    expect(csv[10]).toBeNull()
    expect(csv[18]).toBeNull()
  })

  it('emits expected per-metric counts (pairs preserve -1 terminators, consecutive dedupe)', () => {
    const counts = countByMetric(points)
    // Honestly recomputed by decoding the raw csv arrays with the SAME
    // rules as decodePairs (K6.0: -1 no longer omitted, only consecutive
    // same-ts collisions merge). Verified by direct script: for this
    // fixture there are zero consecutive same-ts collisions in any of
    // these four series, so decoded count === raw pair count exactly.
    //   amazon:     raw pairs 1662 (443 are -1)  → 1662
    //   new:        raw pairs 1158 (180 are -1)  → 1158
    //   salesrank:  raw pairs 14247 (17 are -1)  → 14247
    //   offercount: raw pairs 5332 (339 are -1)  → 5332
    expect(counts.amazon).toBe(1662)
    expect(counts.new).toBe(1158)
    expect(counts.salesrank).toBe(14_247)
    expect(counts.offercount).toBe(5332)
    expect(counts.new_fba).toBeUndefined()
    expect(counts.buybox).toBeUndefined()
    expect(points.every((p) => p.asin === 'B00FLYWNYQ')).toBe(true)
  })

  it('(a) emits an explicit terminator point for a -1 in a pair series (K6.0)', () => {
    // Raw csv[0] (amazon) first entry is [3628028, -1] — previously dropped
    // entirely; now preserved as an explicit value:-1 terminator point.
    const amazon = points.filter((p) => p.metric === 'amazon')
    expect(amazon[0]).toEqual({
      asin: 'B00FLYWNYQ',
      metric: 'amazon',
      ts: '2017-11-24T11:08:00.000Z',
      value: -1,
    })
    // 'new' series shares the same leading -1 raw entry at the same ts.
    const newSeries = points.filter((p) => p.metric === 'new')
    expect(newSeries[0]).toEqual({
      asin: 'B00FLYWNYQ',
      metric: 'new',
      ts: '2017-11-24T11:08:00.000Z',
      value: -1,
    })
  })

  it('(c) real (non-terminator) amazon values still normalize correctly at the series edges', () => {
    // First REAL amazon point (raw csv[0] second pair [3628244, 7995]) —
    // immediately follows the leading -1 terminator.
    const amazon = points.filter((p) => p.metric === 'amazon')
    expect(amazon[1]).toEqual({
      asin: 'B00FLYWNYQ',
      metric: 'amazon',
      ts: '2017-11-24T14:44:00.000Z',
      value: 7995,
    })
    const last = amazon[amazon.length - 1]
    expect(last).toEqual({
      asin: 'B00FLYWNYQ',
      metric: 'amazon',
      ts: '2026-07-22T05:10:00.000Z',
      value: 10_407,
    })
  })

  it('matches first/last salesrank from raw csv[3] (unaffected — neither end is -1)', () => {
    const { first, last } = firstLast(points, 'salesrank')
    expect(first).toEqual({
      asin: 'B00FLYWNYQ',
      metric: 'salesrank',
      ts: '2017-11-24T11:08:00.000Z',
      value: 4,
    })
    expect(last).toEqual({
      asin: 'B00FLYWNYQ',
      metric: 'salesrank',
      ts: '2026-07-22T12:20:00.000Z',
      value: 574,
    })
  })

  it('matches first/last new series values, including the leading terminator', () => {
    const newPts = points.filter((p) => p.metric === 'new')
    expect(newPts[0]).toMatchObject({ ts: '2017-11-24T11:08:00.000Z', value: -1 })
    expect(newPts[1]).toMatchObject({ ts: '2017-11-27T15:08:00.000Z', value: 8496 })
    expect(newPts[newPts.length - 1]).toMatchObject({
      ts: '2026-07-22T06:48:00.000Z',
      value: 10_407,
    })
  })

  it('matches first/last offercount from raw csv[11] (unaffected — neither end is -1)', () => {
    const offers = firstLast(points, 'offercount')
    expect(offers.first).toMatchObject({
      ts: '2017-11-24T14:44:00.000Z',
      value: 1,
    })
    expect(offers.last).toMatchObject({
      ts: '2026-07-15T04:12:00.000Z',
      value: 1,
    })
  })

  it('sanity-asserts all fixture timestamps land between 2011 and now', () => {
    const min = Date.parse('2011-01-01T00:00:00.000Z')
    const max = Date.now() + 86_400_000 // allow 1 day clock skew
    expect(points.length).toBeGreaterThan(1000)
    for (const point of points) {
      const ms = Date.parse(point.ts)
      expect(ms).toBeGreaterThanOrEqual(min)
      expect(ms).toBeLessThanOrEqual(max)
    }
  })

  it('prices are integer cents already (no dollar conversion); -1 terminators included', () => {
    const amazon = points.filter((p) => p.metric === 'amazon')
    expect(amazon.every((p) => Number.isInteger(p.value))).toBe(true)
    expect(amazon.some((p) => p.value === -1)).toBe(true)
    // Instant Pot range roughly $50–$200 → 5000–20000 cents historically
    const realAmazon = amazon.filter((p) => p.value !== -1)
    expect(realAmazon[0]!.value).toBeGreaterThan(1000)
    expect(realAmazon[0]!.value).toBeLessThan(1_000_000)
  })
})

describe('normalizeKeepaProduct edge cases', () => {
  it('preserves -1 sentinel values as explicit terminator points (absent ≠ zero, but marked)', () => {
    const points = normalizeKeepaProduct({
      asin: 'B0TEST0001',
      csv: [
        [100, -1, 200, 5000, 300, -1, 400, 0], // amazon: -1, 5000, -1, 0
        null, null, null, null, null, null, null, null, null,
        null, // 10
        null, // 11
        null, null, null, null, null, null,
        null, // 18
      ],
    })
    const amazon = points.filter((p) => p.metric === 'amazon')
    expect(amazon).toHaveLength(4)
    expect(amazon.map((p) => p.value)).toEqual([-1, 5000, -1, 0])
  })

  it('dedupes consecutive same-timestamp entries keeping the LAST', () => {
    const points = normalizeKeepaProduct({
      asin: 'B0TEST0001',
      csv: [
        [100, 1111, 100, 2222, 200, 3333], // two at ts=100 → keep 2222
      ],
    })
    const amazon = points.filter((p) => p.metric === 'amazon')
    expect(amazon).toHaveLength(2)
    expect(amazon[0]).toMatchObject({ value: 2222 })
    expect(amazon[1]).toMatchObject({ value: 3333 })
  })

  it('dedupes consecutive same-timestamp entries even when the last value is -1', () => {
    const points = normalizeKeepaProduct({
      asin: 'B0TEST0001',
      csv: [
        [100, 5000, 100, -1], // two at ts=100 → keep the terminator -1
      ],
    })
    const amazon = points.filter((p) => p.metric === 'amazon')
    expect(amazon).toHaveLength(1)
    expect(amazon[0]).toMatchObject({ value: -1 })
  })

  it('(b) decodes buybox triplets as landed price+shipping; price -1 becomes a value:-1 terminator', () => {
    // Craft synthetic: fixture csv[18] is empty.
    const csv: Array<number[] | null> = new Array(36).fill(null)
    csv[18] = [
      1000, 5000, 300, // landed 5300
      2000, -1, 0, // price -1 → terminator (value -1), regardless of shipping
      3000, 1000, -1, // shipping -1 → treated as 0 → landed 1000
      3000, 1100, 50, // consecutive same-ts → keep landed 1150
    ]
    const points = normalizeKeepaProduct({ asin: 'B0BUYBOX001', csv })
    const buybox = points.filter((p) => p.metric === 'buybox')
    expect(buybox).toHaveLength(3)
    expect(buybox[0]).toMatchObject({
      value: 5300,
      ts: keepaMinutesToIso(1000),
    })
    expect(buybox[1]).toMatchObject({
      value: -1,
      ts: keepaMinutesToIso(2000),
    })
    expect(buybox[2]).toMatchObject({
      value: 1150,
      ts: keepaMinutesToIso(3000),
    })
  })

  it('returns empty for missing asin or csv', () => {
    expect(normalizeKeepaProduct({})).toEqual([])
    expect(normalizeKeepaProduct({ asin: 'B0TEST0001' })).toEqual([])
    expect(normalizeKeepaProduct({ asin: 'B0TEST0001', csv: null })).toEqual([])
  })

  it('ignores unmapped csv indices', () => {
    const csv: Array<number[] | null> = new Array(36).fill(null)
    csv[2] = [100, 9999] // LISTPRICE — ignored
    csv[0] = [100, 1000]
    const points = normalizeKeepaProduct({ asin: 'B0TEST0001', csv })
    expect(points).toHaveLength(1)
    expect(points[0]!.metric).toBe('amazon')
  })
})
