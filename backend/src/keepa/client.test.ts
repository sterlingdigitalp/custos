import { describe, expect, it, vi } from 'vitest'

import {
  KeepaClient,
  KeepaFatalRequestError,
  KeepaTokensExhaustedError,
  KeepaTransientError,
} from './client.js'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('KeepaClient', () => {
  it('requests product history with domain, asin csv, history, buybox', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input))
      expect(url.origin + url.pathname).toBe('https://api.keepa.com/product')
      expect(url.searchParams.get('key')).toBe('test-key')
      expect(url.searchParams.get('domain')).toBe('1')
      expect(url.searchParams.get('asin')).toBe('B00FLYWNYQ,B0TEST0001')
      expect(url.searchParams.get('history')).toBe('1')
      expect(url.searchParams.get('buybox')).toBe('1')
      return jsonResponse({
        products: [{ asin: 'B00FLYWNYQ', csv: [] }],
        tokensLeft: 50,
        refillIn: 1000,
        refillRate: 1,
        tokensConsumed: 2,
      })
    })

    const client = new KeepaClient({ apiKey: 'test-key', fetchImpl })
    const result = await client.getProducts(['B00FLYWNYQ', 'b0test0001'])
    expect(result.tokensConsumed).toBe(2)
    expect(result.products).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('throws KeepaTokensExhaustedError on 429 with refillIn', async () => {
    const client = new KeepaClient({
      apiKey: 'test-key',
      fetchImpl: async () =>
        jsonResponse({ refillIn: 45_000, error: 'tokens' }, 429),
    })
    await expect(client.getProducts(['B00FLYWNYQ'])).rejects.toMatchObject({
      name: 'KeepaTokensExhaustedError',
      status: 429,
      refillIn: 45_000,
    })
  })

  it('throws KeepaTokensExhaustedError on 402', async () => {
    const client = new KeepaClient({
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ refillIn: 60_000 }, 402),
    })
    try {
      await client.getProducts(['B00FLYWNYQ'])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(KeepaTokensExhaustedError)
      expect((err as KeepaTokensExhaustedError).status).toBe(402)
    }
  })

  it('throws fatal on 400 asin issues without retry', async () => {
    let calls = 0
    const client = new KeepaClient({
      apiKey: 'test-key',
      fetchImpl: async () => {
        calls += 1
        return new Response('invalid asin list', { status: 400 })
      },
    })
    await expect(client.getProducts(['BAD'])).rejects.toBeInstanceOf(KeepaFatalRequestError)
    expect(calls).toBe(1)
  })

  it('retries 5xx with backoff then succeeds', async () => {
    let calls = 0
    const sleeps: number[] = []
    const client = new KeepaClient({
      apiKey: 'test-key',
      sleep: async (ms) => { sleeps.push(ms) },
      fetchImpl: async () => {
        calls += 1
        if (calls < 3) return new Response('boom', { status: 503 })
        return jsonResponse({
          products: [],
          tokensLeft: 10,
          refillIn: 0,
          refillRate: 1,
          tokensConsumed: 0,
        })
      },
    })
    const result = await client.getProducts(['B00FLYWNYQ'])
    expect(result.tokensLeft).toBe(10)
    expect(calls).toBe(3)
    expect(sleeps).toEqual([1000, 2000])
  })

  it('throws KeepaTransientError after exhausting 5xx retries', async () => {
    const client = new KeepaClient({
      apiKey: 'test-key',
      maxAttempts: 3,
      sleep: async () => {},
      fetchImpl: async () => new Response('nope', { status: 500 }),
    })
    await expect(client.getProducts(['B00FLYWNYQ'])).rejects.toBeInstanceOf(KeepaTransientError)
  })

  it('retries network errors then fails', async () => {
    let calls = 0
    const client = new KeepaClient({
      apiKey: 'test-key',
      maxAttempts: 2,
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1
        throw new TypeError('fetch failed')
      },
    })
    await expect(client.getProducts(['B00FLYWNYQ'])).rejects.toBeInstanceOf(KeepaTransientError)
    expect(calls).toBe(2)
  })

  it('rejects empty and oversized batches', async () => {
    const client = new KeepaClient({
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ products: [] }),
    })
    await expect(client.getProducts([])).rejects.toThrow(/at least one/i)
    await expect(client.getProducts(Array.from({ length: 101 }, (_, i) => `B${i}`)))
      .rejects.toThrow(/max is 100/i)
  })

  it('does not include the key in error messages', async () => {
    const secret = 'super-secret-key-xyz'
    const client = new KeepaClient({
      apiKey: secret,
      fetchImpl: async () => new Response('invalid asin', { status: 400 }),
    })
    try {
      await client.getProducts(['B00FLYWNYQ'])
    } catch (err) {
      expect(String(err)).not.toContain(secret)
    }
  })
})
