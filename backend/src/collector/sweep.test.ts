import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProduct, getProductByAsin, latestSnapshotForAsin } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import type { CustosApiClient } from '../spapi/client.js'
import { runSweep } from './sweep.js'

describe('runSweep', () => {
  let db: DatabaseHandle | undefined

  afterEach(() => db?.close())

  it('merges offer and catalog results into snapshots and product metadata', async () => {
    db = openDatabase(':memory:')
    createProduct(db, { asin: 'A1' })
    const client: CustosApiClient = {
      getOffers: vi.fn(async () => [{
        asin: 'A1', buyBoxPrice: 19.99, lowestNewPrice: 18.99,
        lowestFbaPrice: 20.5, offerCount: 6, fbaOfferCount: 4,
      }]),
      getCatalog: vi.fn(async () => [{
        asin: 'A1', title: 'Catalog title', brand: 'Acme',
        imageUrl: 'https://example.test/a1.jpg', category: 'Tools',
        salesRank: 1234, rankCategory: 'Power Tools',
      }]),
      searchByKeywords: vi.fn(async () => ({ items: [], nextPageToken: null })),
      ping: vi.fn(async () => ({ ok: true, detail: 'test' })),
    }
    const summary = await runSweep(db, client, new Date('2026-02-01T12:00:00.000Z'))
    expect(summary).toEqual({
      ts: '2026-02-01T12:00:00.000Z', asins: 1,
      offersFetched: 1, catalogFetched: 1, bothMissed: 0,
    })
    expect(latestSnapshotForAsin(db, 'A1')).toMatchObject({
      buyBoxPrice: 19.99, offerCount: 6, salesRank: 1234, rankCategory: 'Power Tools',
    })
    expect(getProductByAsin(db, 'A1')).toMatchObject({
      title: 'Catalog title', brand: 'Acme', category: 'Tools', rankCategory: 'Power Tools',
    })
    expect(client.getOffers).toHaveBeenCalledTimes(1)
    expect(client.getCatalog).toHaveBeenCalledTimes(1)
    expect(client.getOffers).toHaveBeenCalledWith(['A1'])
  })

  it('writes partial and all-null rows and reports source counts and both-source misses', async () => {
    db = openDatabase(':memory:')
    createProduct(db, { asin: 'OFFERS_ONLY' })
    createProduct(db, { asin: 'CATALOG_ONLY' })
    createProduct(db, { asin: 'ABSENT' })
    const client: CustosApiClient = {
      getOffers: async () => [{
        asin: 'OFFERS_ONLY', buyBoxPrice: null, lowestNewPrice: 12,
        lowestFbaPrice: null, offerCount: 2, fbaOfferCount: 0,
      }],
      getCatalog: async () => [{
        asin: 'CATALOG_ONLY', title: 'Only catalog', brand: null, imageUrl: null,
        category: null, salesRank: 99, rankCategory: 'Category',
      }],
      searchByKeywords: async () => ({ items: [], nextPageToken: null }),
      ping: async () => ({ ok: true, detail: 'test' }),
    }
    expect(await runSweep(db, client, '2026-02-01T12:00:00.000Z')).toMatchObject({
      asins: 3, offersFetched: 1, catalogFetched: 1, bothMissed: 1,
    })
    expect(latestSnapshotForAsin(db, 'OFFERS_ONLY')).toMatchObject({
      lowestNewPrice: 12, salesRank: null,
    })
    expect(latestSnapshotForAsin(db, 'CATALOG_ONLY')).toMatchObject({
      buyBoxPrice: null, offerCount: null, salesRank: 99,
    })
    expect(latestSnapshotForAsin(db, 'ABSENT')).toMatchObject({
      buyBoxPrice: null, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: null, fbaOfferCount: null, salesRank: null, rankCategory: null,
    })
  })

  it('does not poll archived products', async () => {
    db = openDatabase(':memory:')
    createProduct(db, { asin: 'ACTIVE' })
    createProduct(db, { asin: 'ARCHIVED', isArchived: true })
    const getOffers = vi.fn(async () => [])
    const getCatalog = vi.fn(async () => [])
    const client: CustosApiClient = {
      getOffers,
      getCatalog,
      searchByKeywords: async () => ({ items: [], nextPageToken: null }),
      ping: async () => ({ ok: true, detail: 'test' }),
    }
    const summary = await runSweep(db, client, new Date('2026-02-01T12:00:00.000Z'))
    expect(summary.asins).toBe(1)
    expect(getOffers).toHaveBeenCalledWith(['ACTIVE'])
    expect(latestSnapshotForAsin(db, 'ARCHIVED')).toBeUndefined()
  })
})
