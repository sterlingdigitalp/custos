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

  it('paces pricing chunks and isolates a failed chunk (5xx retried once, still fails)', async () => {
    let batchCall = 0
    const delays: number[] = []
    const fetchImpl: Fetch = async (input, init) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      batchCall += 1
      // Chunk 1 fails on both its initial attempt and its one retry.
      if (batchCall <= 2) return json({ message: 'failed chunk' }, 500)
      const body = JSON.parse(String(init?.body)) as { requests: Array<{ uri: string }> }
      return json({ responses: body.requests.map(({ uri }) => ({
        status: { statusCode: 200 }, request: { uri }, body: { payload: { Offers: [] } },
      })) })
    }
    const client = new LiveCustosClient(
      settings(), fetchImpl, async (ms) => { delays.push(ms) }, 321, 600,
    )
    const results = await client.getOffers(Array.from({ length: 21 }, (_, index) => `A${index}`))
    // [retry delay for chunk 1's 5xx, inter-chunk pacing delay]
    expect(delays).toEqual([10_000, 321])
    expect(results.map(({ asin }) => asin)).toEqual(['A20'])
    expect(client.getLastChunkFailures()).toEqual({ pricing: 1, catalog: 0 })
  })

  it('retries a single 5xx pricing chunk once and recovers on success', async () => {
    let batchCall = 0
    const delays: number[] = []
    const fetchImpl: Fetch = async (input, init) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      batchCall += 1
      if (batchCall === 1) return json({ message: 'transient' }, 503)
      const body = JSON.parse(String(init?.body)) as { requests: Array<{ uri: string }> }
      return json({ responses: body.requests.map(({ uri }) => ({
        status: { statusCode: 200 }, request: { uri }, body: { payload: { ASIN: 'B0OK', Offers: [] } },
      })) })
    }
    const client = new LiveCustosClient(settings(), fetchImpl, async (ms) => { delays.push(ms) })
    const results = await client.getOffers(['B0OK'])
    expect(delays).toEqual([10_000])
    expect(results.map(({ asin }) => asin)).toEqual(['B0OK'])
    expect(client.getLastChunkFailures()).toEqual({ pricing: 0, catalog: 0 })
  })

  it('logs a chunk failure without leaking the LWA/refresh credentials', async () => {
    const logs: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    try {
      const fetchImpl: Fetch = async (input) => {
        if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
        return json({ message: 'boom' }, 500)
      }
      const client = new LiveCustosClient(settings(), fetchImpl, async () => {})
      await client.getOffers(['A1'])
      expect(logs.length).toBeGreaterThan(0)
      const combined = logs.join('\n')
      expect(combined).toContain('pricing')
      expect(combined).not.toContain('secret')
      expect(combined).not.toContain('refresh')
      expect(combined).not.toContain('token')
    } finally {
      console.error = originalError
    }
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
      // Chunk 1 fails on both its initial attempt and its one retry.
      return calls <= 2 ? json({ error: 'nope' }, 500) : json({ items: [{ asin: 'A20' }] })
    }
    const client = new LiveCustosClient(
      settings(), fetchImpl, async (ms) => { delays.push(ms) }, 10_000, 87,
    )
    const result = await client.getCatalog(Array.from({ length: 21 }, (_, index) => `A${index}`))
    // [retry delay for chunk 1's 5xx, inter-chunk pacing delay]
    expect(delays).toEqual([10_000, 87])
    expect(result.map(({ asin }) => asin)).toEqual(['A20'])
    expect(client.getLastChunkFailures()).toEqual({ pricing: 0, catalog: 1 })
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

  it('caps an unbounded Retry-After at 60s instead of parking the sweep', async () => {
    let requests = 0
    const delays: number[] = []
    const fetchImpl: Fetch = async (input) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      requests += 1
      // Amazon has sent values like this (a full day) — must never be honored as-is.
      if (requests === 1) return json({}, 429, { 'retry-after': '86400' })
      return json({ items: [] })
    }
    const client = new LiveCustosClient(settings(), fetchImpl, async (ms) => { delays.push(ms) })
    await expect(client.getCatalog(['A1'])).resolves.toEqual([])
    expect(delays).toEqual([60_000])
  })

  it('caps the retry delay at 60s for a 5xx too', async () => {
    let requests = 0
    const delays: number[] = []
    const fetchImpl: Fetch = async (input) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      requests += 1
      if (requests === 1) return json({}, 503, { 'retry-after': '3600' })
      return json({ items: [] })
    }
    const client = new LiveCustosClient(settings(), fetchImpl, async (ms) => { delays.push(ms) })
    await expect(client.getCatalog(['A1'])).resolves.toEqual([])
    expect(delays).toEqual([60_000])
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

  it('a hung pricing request times out, retries once (like a 5xx), and is counted as a chunk failure — not an empty-but-successful result', async () => {
    const delays: number[] = []
    const fetchImpl: Fetch = async (input) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      return new Promise<Response>(() => {}) // never resolves — simulates a wedged socket
    }
    const client = new LiveCustosClient(
      settings(), fetchImpl, async (ms) => { delays.push(ms) }, 10_000, 600, undefined, 15,
    )
    const start = Date.now()
    const results = await client.getOffers(['A1'])
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(results).toEqual([])
    expect(client.getLastChunkFailures()).toEqual({ pricing: 1, catalog: 0 })
  })

  it('timeout error message states the elapsed budget and never leaks LWA credentials', async () => {
    const logs: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    try {
      const fetchImpl: Fetch = async (input) => {
        if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
        return new Promise<Response>(() => {})
      }
      const client = new LiveCustosClient(
        settings(), fetchImpl, async () => {}, 10_000, 600, undefined, 15,
      )
      await client.getOffers(['A1'])
      const combined = logs.join('\n')
      expect(combined).toContain('15ms')
      expect(combined).not.toContain('secret')
      expect(combined).not.toContain('refresh')
    } finally {
      console.error = originalError
    }
  })

  it('is unaffected when the pricing fetch resolves normally (no regression)', async () => {
    const fetchImpl: Fetch = async (input, init) => {
      if (String(input).includes('/auth/o2/token')) return json({ access_token: 'token', expires_in: 3600 })
      const body = JSON.parse(String(init?.body)) as { requests: Array<{ uri: string }> }
      return json({ responses: body.requests.map(({ uri }) => ({
        status: { statusCode: 200 }, request: { uri }, body: { payload: { ASIN: 'A1', Offers: [] } },
      })) })
    }
    const client = new LiveCustosClient(settings(), fetchImpl, async () => {}, 10_000, 600, undefined, 15)
    const results = await client.getOffers(['A1'])
    expect(results.map(({ asin }) => asin)).toEqual(['A1'])
    expect(client.getLastChunkFailures()).toEqual({ pricing: 0, catalog: 0 })
  })
})
