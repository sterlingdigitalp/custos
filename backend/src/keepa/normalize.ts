// Keepa product CSV → keepa_points rows (KEEPA-BACKFILL.md K2).
// Encoding verified against fixtures/keepa-product-B00FLYWNYQ.json.gz.

export type KeepaMetric =
  | 'amazon'
  | 'new'
  | 'new_fba'
  | 'buybox'
  | 'salesrank'
  | 'offercount'

export interface KeepaPoint {
  asin: string
  metric: KeepaMetric
  ts: string
  value: number
}

/** Keepa minutes → ISO-8601 UTC. unixMs = (keepaMinutes + 21564000) * 60000 */
export function keepaMinutesToIso(keepaMinutes: number): string {
  return new Date((keepaMinutes + 21_564_000) * 60_000).toISOString()
}

/** Indices we normalize; all others ignored. Index 18 is buybox triplets. */
const METRIC_BY_INDEX: ReadonlyMap<number, KeepaMetric> = new Map([
  [0, 'amazon'],
  [1, 'new'],
  [10, 'new_fba'],
  [18, 'buybox'],
  [3, 'salesrank'],
  [11, 'offercount'],
])

const BUY_BOX_SHIPPING_INDEX = 18

export interface KeepaProductLike {
  asin?: string | null
  csv?: Array<number[] | null> | null
}

/**
 * Normalize one Keepa product object into point rows.
 * - Pair series: [keepaMinutes, value, ...]
 * - BUY_BOX_SHIPPING (index 18): [keepaMinutes, priceCents, shippingCents, ...]
 *   landed value = price + shipping (shipping -1 treated as 0)
 * - value/price -1 → omit (absent ≠ zero)
 * - Consecutive same-timestamp entries keep the LAST value
 */
export function normalizeKeepaProduct(product: KeepaProductLike): KeepaPoint[] {
  const asin = typeof product.asin === 'string' ? product.asin.trim().toUpperCase() : ''
  if (!asin || !product.csv) return []

  const points: KeepaPoint[] = []

  for (const [index, metric] of METRIC_BY_INDEX) {
    const series = product.csv[index]
    if (!series || series.length === 0) continue

    const entries =
      index === BUY_BOX_SHIPPING_INDEX
        ? decodeTriplets(series)
        : decodePairs(series)

    for (const [keepaMinutes, value] of entries) {
      points.push({
        asin,
        metric,
        ts: keepaMinutesToIso(keepaMinutes),
        value,
      })
    }
  }

  return points
}

/** Decode pair series; omit -1; consecutive same-ts keep last. */
function decodePairs(series: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i + 1 < series.length; i += 2) {
    const keepaMinutes = series[i]!
    const value = series[i + 1]!
    if (value === -1) continue
    if (out.length > 0 && out[out.length - 1]![0] === keepaMinutes) {
      out[out.length - 1] = [keepaMinutes, value]
    } else {
      out.push([keepaMinutes, value])
    }
  }
  return out
}

/**
 * Decode BUY_BOX_SHIPPING triplets.
 * Omit when price === -1. Landed = price + max(shipping, 0) when shipping is -1.
 */
function decodeTriplets(series: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i + 2 < series.length; i += 3) {
    const keepaMinutes = series[i]!
    const price = series[i + 1]!
    const shipping = series[i + 2]!
    if (price === -1) continue
    const landed = price + (shipping === -1 ? 0 : shipping)
    if (out.length > 0 && out[out.length - 1]![0] === keepaMinutes) {
      out[out.length - 1] = [keepaMinutes, landed]
    } else {
      out.push([keepaMinutes, landed])
    }
  }
  return out
}
