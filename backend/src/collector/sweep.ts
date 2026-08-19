import {
  insertSnapshot,
  listNonArchivedProducts,
  updateProductCatalog,
} from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'
import type { CustosApiClient } from '../spapi/client.js'

export interface SweepSummary {
  ts: string
  asins: number
  asinsSwept: number
  offersFetched: number
  catalogFetched: number
  bothMissed: number
  /** Pricing + catalog chunk failures (transient 5xx/auth/JSON errors) from
   * this sweep's client calls, so a failure never hides as a silent zero. */
  chunkFailures: number
}

function asDate(now: Date | string): Date {
  return typeof now === 'string' ? new Date(now) : now
}

/**
 * `asins` optionally scopes the sweep to a specific list (tier-aware
 * scheduling passes hot + a rotating cold slice). Defaults to every active
 * product, preserving prior full-corpus behavior for existing callers.
 */
export async function runSweep(
  db: DatabaseHandle,
  client: CustosApiClient,
  now: Date | string,
  asinsOverride?: string[],
): Promise<SweepSummary> {
  const asins = asinsOverride ?? listNonArchivedProducts(db).map((product) => product.asin)
  const ts = asDate(now).toISOString()

  const [offerResults, catalogResults] = await Promise.all([
    client.getOffers(asins),
    client.getCatalog(asins),
  ])
  const failures = client.getLastChunkFailures?.()
  const chunkFailures = (failures?.pricing ?? 0) + (failures?.catalog ?? 0)
  const tracked = new Set(asins)
  const offersByAsin = new Map(
    offerResults.filter((result) => tracked.has(result.asin)).map((result) => [result.asin, result]),
  )
  const catalogByAsin = new Map(
    catalogResults
      .filter((result) => tracked.has(result.asin))
      .map((result) => [result.asin, result]),
  )

  let bothMissed = 0
  db.transaction(() => {
    for (const asin of asins) {
      const offers = offersByAsin.get(asin)
      const catalog = catalogByAsin.get(asin)
      if (!offers && !catalog) {
        bothMissed += 1
      }
      insertSnapshot(db, {
        asin,
        ts,
        buyBoxPrice: offers?.buyBoxPrice ?? null,
        lowestNewPrice: offers?.lowestNewPrice ?? null,
        lowestFbaPrice: offers?.lowestFbaPrice ?? null,
        offerCount: offers?.offerCount ?? null,
        fbaOfferCount: offers?.fbaOfferCount ?? null,
        salesRank: catalog?.salesRank ?? null,
        rankCategory: catalog?.rankCategory ?? null,
      })
      if (catalog) {
        updateProductCatalog(db, asin, {
          title: catalog.title,
          brand: catalog.brand,
          imageUrl: catalog.imageUrl,
          category: catalog.category,
          rankCategory: catalog.rankCategory,
        })
      }
    }
  })()

  return {
    ts,
    asins: asins.length,
    asinsSwept: asins.length,
    offersFetched: offersByAsin.size,
    catalogFetched: catalogByAsin.size,
    bothMissed,
    chunkFailures,
  }
}
