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
  offersFetched: number
  catalogFetched: number
  bothMissed: number
}

function asDate(now: Date | string): Date {
  return typeof now === 'string' ? new Date(now) : now
}

export async function runSweep(
  db: DatabaseHandle,
  client: CustosApiClient,
  now: Date | string,
): Promise<SweepSummary> {
  const products = listNonArchivedProducts(db)
  const asins = products.map((product) => product.asin)
  const ts = asDate(now).toISOString()

  const [offerResults, catalogResults] = await Promise.all([
    client.getOffers(asins),
    client.getCatalog(asins),
  ])
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
    for (const product of products) {
      const offers = offersByAsin.get(product.asin)
      const catalog = catalogByAsin.get(product.asin)
      if (!offers && !catalog) {
        bothMissed += 1
      }
      insertSnapshot(db, {
        asin: product.asin,
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
        updateProductCatalog(db, product.asin, {
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
    offersFetched: offersByAsin.size,
    catalogFetched: catalogByAsin.size,
    bothMissed,
  }
}
