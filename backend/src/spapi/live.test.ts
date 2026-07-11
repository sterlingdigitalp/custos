import { describe, expect, it } from 'vitest'

import { LiveCustosClient, type LiveCustosClientSettings } from './live.js'
import { LwaTokenManager, type Fetch } from './lwa.js'

interface FetchCall { url: string; init?: RequestInit }

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function settings(): LiveCustosClientSettings {
  return {
    lwaClientId: 'id', lwaClientSecret: 'secret', refreshToken: 'refresh',
    marketplaceId: 'ATVPDKIKX0DER', region: 'na',
  }
}

describe('LwaTokenManager', () => {
  it('caches until the 60-second expiry buffer', async () => {
    let now = 0
    let exchanges = 0
    const fetchImpl: Fetch = async () => json({
      access_token: `token-${++exchanges}`,
      expires_in: 120,
    })
    const manager = new LwaTokenManager({
      clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh',
    }, fetchImpl, () => now)

    await expect(manager.getAccessToken()).resolves.toBe('token-1')
    now = 59_999
    await expect(manager.getAccessToken()).resolves.toBe('token-1')
    now = 60_000
    await expect(manager.getAccessToken()).resolves.toBe('token-2')
    expect(exchanges).toBe(2)
  })
})

describe('LiveCustosClient', () => {
  it('pins pricing batch shape and maps landed offer metrics', async () => {
    const calls: FetchCall[] = []
    const fetchImpl: Fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      if (String(input).includes('/auth/o2/token')) {
        return json({ access_token: 'token', expires_in: 3600 })
      }
      return json({ responses: [{
        status: { statusCode: 200 },
        body: { payload: { ASIN: 'B0TEST', Offers: [
          { ListingPrice: { Amount: 20 }, Shipping: { Amount: 2 }, IsBuyBoxWinner: true, IsFulfilledByAmazon: true },
          { ListingPrice: { Amount: 19 }, Shipping: { Amount: 1 }, IsFulfilledByAmazon: false },
          { ListingPrice: { Amount: 23 }, IsFulfilledByAmazon: true },
        ] } },
      }] })
    }
    const client = new LiveCustosClient(settings(), fetchImpl)
    await expect(client.getOffers(['B0TEST'])).resolves.toEqual([{
      asin: 'B0TEST', buyBoxPrice: 22, lowestNewPrice: 20,
      lowestFbaPrice: 22, offerCount: 3, fbaOfferCount: 2,
    }])
    const call = calls.find(({ url }) => url.includes('/batches/')) as FetchCall
    expect(JSON.parse(String(call.init?.body))).toEqual({ requests: [{
      uri: '/products/pricing/v0/items/B0TEST/offers',
      method: 'GET', MarketplaceId: 'ATVPDKIKX0DER', ItemCondition: 'New',
    }] })
  })

  it('paces pricing chunks and isolates a failed chunk', async () => {
    let batchCall = 0
    const delays: number[] = []
    const fetchImpl: Fetch = async (input, init) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      batchCall += 1
      if (batchCall === 1) return json({ message: 'failed chunk' }, 500)
      const body = JSON.parse(String(init?.body)) as { requests: Array<{ uri: string }> }
      return json({ responses: body.requests.map(({ uri }) => ({
        status: { statusCode: 200 }, request: { uri }, body: { payload: { Offers: [] } },
      })) })
    }
    const client = new LiveCustosClient(
      settings(), fetchImpl, async (ms) => { delays.push(ms) }, 321, 600,
    )
    const results = await client.getOffers(Array.from({ length: 21 }, (_, index) => `A${index}`))
    expect(delays).toEqual([321])
    expect(results.map(({ asin }) => asin)).toEqual(['A20'])
  })

  it('pins catalog identifiers and prefers display-group rank', async () => {
    const calls: FetchCall[] = []
    const fetchImpl: Fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      return json({ items: [{
        asin: 'A1',
        summaries: [{ itemName: 'Widget', brand: 'Acme', browseClassification: { displayName: 'Tools' } }],
        images: [{ images: [{ variant: 'PT01', link: 'other' }, { variant: 'MAIN', link: 'main.jpg' }] }],
        salesRanks: [{
          classificationRanks: [{ title: 'Classification', rank: 900 }],
          displayGroupRanks: [{ title: 'Display group', rank: 123 }],
        }],
      }] })
    }
    const client = new LiveCustosClient(settings(), fetchImpl)
    await expect(client.getCatalog(['A1', 'A2'])).resolves.toEqual([{
      asin: 'A1', title: 'Widget', brand: 'Acme', imageUrl: 'main.jpg', category: 'Tools',
      salesRank: 123, rankCategory: 'Display group',
    }])
    const catalogUrl = new URL(calls.find(({ url }) => url.includes('/catalog/'))?.url ?? '')
    expect(catalogUrl.searchParams.get('identifiers')).toBe('A1,A2')
    expect(catalogUrl.searchParams.get('identifiersType')).toBe('ASIN')
    expect(catalogUrl.searchParams.get('includedData')).toBe('salesRanks,summaries,images')
  })

  it('paces catalog chunks and keeps later chunks after failure', async () => {
    let calls = 0
    const delays: number[] = []
    const fetchImpl: Fetch = async (input) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      calls += 1
      return calls === 1 ? json({ error: 'nope' }, 500) : json({ items: [{ asin: 'A20' }] })
    }
    const client = new LiveCustosClient(
      settings(), fetchImpl, async (ms) => { delays.push(ms) }, 10_000, 87,
    )
    const result = await client.getCatalog(Array.from({ length: 21 }, (_, index) => `A${index}`))
    expect(delays).toEqual([87])
    expect(result.map(({ asin }) => asin)).toEqual(['A20'])
  })

  it('retries one 429 using Retry-After and no more', async () => {
    let requests = 0
    const delays: number[] = []
    const fetchImpl: Fetch = async (input) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      requests += 1
      if (requests === 1) return json({}, 429, { 'retry-after': '2' })
      return json({ items: [] })
    }
    const client = new LiveCustosClient(settings(), fetchImpl, async (ms) => { delays.push(ms) })
    await expect(client.getCatalog(['A1'])).resolves.toEqual([])
    expect(requests).toBe(2)
    expect(delays).toEqual([2000])
  })

  it('maps paged keyword search and page token', async () => {
    let requestUrl = ''
    const fetchImpl: Fetch = async (input) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      requestUrl = String(input)
      return json({ items: [{ asin: 'A1', summaries: [{ itemName: 'Lamp' }] }], pagination: { nextToken: 'NEXT' } })
    }
    const client = new LiveCustosClient(settings(), fetchImpl)
    const result = await client.searchByKeywords('desk lamp', 'PAGE')
    expect(result.nextPageToken).toBe('NEXT')
    expect(result.items[0]).toMatchObject({ asin: 'A1', title: 'Lamp' })
    expect(new URL(requestUrl).searchParams.get('pageToken')).toBe('PAGE')
  })
})
