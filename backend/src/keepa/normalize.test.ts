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

  it('emits expected per-metric counts (pairs, -1 omitted, consecutive dedupe)', () => {
    const counts = countByMetric(points)
    // Hand-verified from raw arrays with the same decode rules.
    expect(counts.amazon).toBe(1219)
    expect(counts.new).toBe(978)
    expect(counts.salesrank).toBe(14_230)
    expect(counts.offercount).toBe(4993)
    expect(counts.new_fba).toBeUndefined()
    expect(counts.buybox).toBeUndefined()
    expect(points.every((p) => p.asin === 'B00FLYWNYQ')).toBe(true)
  })

  it('matches first/last amazon values and timestamps from raw csv[0]', () => {
    // csv[0] first non-(-1): [3628244, 7995]; last: [8180950, 10407]
    const { first, last } = firstLast(points, 'amazon')
    expect(first).toEqual({
      asin: 'B00FLYWNYQ',
      metric: 'amazon',
      ts: '2017-11-24T14:44:00.000Z',
      value: 7995,
    })
    expect(last).toEqual({
      asin: 'B00FLYWNYQ',
      metric: 'amazon',
      ts: '2026-07-22T05:10:00.000Z',
      value: 10_407,
    })
  })

  it('matches first/last salesrank from raw csv[3]', () => {
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

  it('matches first/last new and offercount from raw arrays', () => {
    const newPts = firstLast(points, 'new')
    expect(newPts.first).toMatchObject({
      ts: '2017-11-27T15:08:00.000Z',
      value: 8496,
    })
    expect(newPts.last).toMatchObject({
      ts: '2026-07-22T06:48:00.000Z',
      value: 10_407,
    })

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

  it('prices are integer cents already (no dollar conversion)', () => {
    const amazon = points.filter((p) => p.metric === 'amazon')
    expect(amazon.every((p) => Number.isInteger(p.value))).toBe(true)
    // Instant Pot range roughly $50–$200 → 5000–20000 cents historically
    expect(amazon[0]!.value).toBeGreaterThan(1000)
    expect(amazon[0]!.value).toBeLessThan(1_000_000)
  })
})

describe('normalizeKeepaProduct edge cases', () => {
  it('omits -1 sentinel values entirely (absent ≠ zero)', () => {
    const points = normalizeKeepaProduct({
      asin: 'B0TEST0001',
      csv: [
        [100, -1, 200, 5000, 300, -1, 400, 0], // amazon: keep 5000 and 0
        null, null, null, null, null, null, null, null, null,
        null, // 10
        null, // 11
        null, null, null, null, null, null,
        null, // 18
      ],
    })
    const amazon = points.filter((p) => p.metric === 'amazon')
    expect(amazon).toHaveLength(2)
    expect(amazon.map((p) => p.value)).toEqual([5000, 0])
    expect(amazon.every((p) => p.value !== -1)).toBe(true)
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

  it('decodes buybox triplets as landed price+shipping; omits price -1', () => {
    // Craft synthetic: fixture csv[18] is empty.
    const csv: Array<number[] | null> = new Array(36).fill(null)
    csv[18] = [
      1000, 5000, 300, // landed 5300
      2000, -1, 0, // omit
      3000, 1000, -1, // shipping -1 → 0 → landed 1000
      3000, 1100, 50, // consecutive same-ts → keep 1150
    ]
    const points = normalizeKeepaProduct({ asin: 'B0BUYBOX001', csv })
    const buybox = points.filter((p) => p.metric === 'buybox')
    expect(buybox).toHaveLength(2)
    expect(buybox[0]).toMatchObject({
      value: 5300,
      ts: keepaMinutesToIso(1000),
    })
    expect(buybox[1]).toMatchObject({
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
