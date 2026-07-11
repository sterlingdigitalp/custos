import { describe, expect, it } from 'vitest'
import { createCustosClient } from './client.js'
import { LiveCustosClient } from './live.js'
import { defaultFixtures, MockCustosApiClient } from './mock.js'

describe('MockCustosApiClient', () => {
  it('produces identical stateful series for two clients with the same fixtures', async () => {
    const left = new MockCustosApiClient(defaultFixtures())
    const right = new MockCustosApiClient(defaultFixtures())
    const asins = ['B0CUSTOS01', 'B0CUSTOS07']
    const leftSeries = []
    const rightSeries = []
    for (let index = 0; index < 4; index += 1) {
      leftSeries.push(await left.getOffers(asins), await left.getCatalog(asins))
      rightSeries.push(await right.getOffers(asins), await right.getCatalog(asins))
    }
    expect(leftSeries).toEqual(rightSeries)
  })

  it('omits unknown ASINs instead of fabricating results', async () => {
    const client = new MockCustosApiClient(defaultFixtures())
    expect(await client.getOffers(['UNKNOWN'])).toEqual([])
    expect(await client.getCatalog(['UNKNOWN'])).toEqual([])
  })

  it('takes the designated fixture out of stock on every fifth offer tick', async () => {
    const client = new MockCustosApiClient(defaultFixtures())
    const series = []
    for (let index = 0; index < 5; index += 1) {
      series.push((await client.getOffers(['B0CUSTOS04']))[0])
    }
    expect(series.slice(0, 4).every((snapshot) => snapshot.offerCount > 0)).toBe(true)
    expect(series[4]).toMatchObject({
      buyBoxPrice: null,
      lowestNewPrice: null,
      offerCount: 0,
      fbaOfferCount: 0,
    })
  })

  it('steadily improves the designated sales-rank fixture', async () => {
    const client = new MockCustosApiClient(defaultFixtures())
    const ranks = []
    for (let index = 0; index < 4; index += 1) {
      ranks.push((await client.getCatalog(['B0CUSTOS07']))[0].salesRank as number)
    }
    expect(ranks[1]).toBeLessThan(ranks[0])
    expect(ranks[2]).toBeLessThan(ranks[1])
    expect(ranks[3]).toBeLessThan(ranks[2])
  })

  it('factory selects mock for incomplete credentials and live for complete credentials', () => {
    expect(createCustosClient({
      lwaClientId: null,
      lwaClientSecret: null,
      refreshToken: null,
    })).toBeInstanceOf(MockCustosApiClient)
    expect(createCustosClient({
      lwaClientId: 'id',
      lwaClientSecret: 'secret',
      refreshToken: 'token',
    })).toBeInstanceOf(LiveCustosClient)
  })
})
