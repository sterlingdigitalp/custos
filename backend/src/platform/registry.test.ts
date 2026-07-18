import { newId } from '@platform/contract'
import { describe, expect, it, vi } from 'vitest'

import type { HubConfig } from './config.js'
import { HubAuthError, RegistryClient, type FetchLike } from './registry.js'

const HUB: HubConfig = {
  baseUrl: 'http://hub.test',
  token: 'secret-token',
  accountId: newId('acct', 600_000),
  marketplaceId: 'ATVPDKIKX0DER',
}

const PRODUCT_ID = newId('prd', 600_000)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('RegistryClient.resolveProduct', () => {
  it('POSTs resolve body without accountId/source/Idempotency-Key and validates productId', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init })
      return jsonResponse({
        status: 'resolved',
        productId: PRODUCT_ID,
        registryVersion: 3,
        created: true,
        conflictId: null,
      })
    }
    const sleep = vi.fn(async () => {})
    const client = new RegistryClient(HUB, fetchImpl, sleep)
    await expect(client.resolveProduct({ asin: 'B00FLYWNYQ', title: 'Instant Pot' }))
      .resolves.toEqual({
        status: 'resolved',
        productId: PRODUCT_ID,
        registryVersion: 3,
        created: true,
        conflictId: null,
      })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://hub.test/registry/products/resolve')
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer secret-token')
    expect(headers.get('Idempotency-Key')).toBeNull()
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      marketplaceId: 'ATVPDKIKX0DER',
      asin: 'B00FLYWNYQ',
      title: 'Instant Pot',
    })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('omits title when undefined/empty', async () => {
    const bodies: unknown[] = []
    const fetchImpl: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return jsonResponse({
        status: 'resolved',
        productId: PRODUCT_ID,
        registryVersion: 1,
        created: false,
        conflictId: null,
      })
    }
    const client = new RegistryClient(HUB, fetchImpl, async () => {})
    await client.resolveProduct({ asin: 'B00FLYWNYQ' })
    await client.resolveProduct({ asin: 'B00FLYWNYQ', title: null })
    await client.resolveProduct({ asin: 'B00FLYWNYQ', title: '' })
    for (const body of bodies) {
      expect(body).toEqual({ marketplaceId: 'ATVPDKIKX0DER', asin: 'B00FLYWNYQ' })
    }
  })

  it('returns conflict:true on HTTP 409 without retrying', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return jsonResponse({ code: 'PRODUCT_IDENTIFIERS_DISAGREE' }, 409)
    }
    const sleep = vi.fn(async () => {})
    const client = new RegistryClient(HUB, fetchImpl, sleep)
    await expect(client.resolveProduct({ asin: 'B00CONFLICT' }))
      .resolves.toEqual({
        conflict: true,
        body: { code: 'PRODUCT_IDENTIFIERS_DISAGREE' },
      })
    expect(calls).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('throws HubAuthError on 401/403 without retrying', async () => {
    for (const status of [401, 403]) {
      let calls = 0
      const fetchImpl: FetchLike = async () => {
        calls += 1
        return new Response('denied', { status })
      }
      const sleep = vi.fn(async () => {})
      const client = new RegistryClient(HUB, fetchImpl, sleep)
      await expect(client.resolveProduct({ asin: 'B00AUTH' }))
        .rejects.toBeInstanceOf(HubAuthError)
      expect(calls).toBe(1)
      expect(sleep).not.toHaveBeenCalled()
    }
  })

  it('retries 5xx with 1s/2s/4s backoff then throws', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return new Response('boom', { status: 503 })
    }
    const sleeps: number[] = []
    const client = new RegistryClient(HUB, fetchImpl, async (ms) => {
      sleeps.push(ms)
    })
    await expect(client.resolveProduct({ asin: 'B00RETRY' }))
      .rejects.toThrow(/server error.*after 4 attempts/)
    expect(calls).toBe(4)
    expect(sleeps).toEqual([1_000, 2_000, 4_000])
  })

  it('retries network errors with the same backoff then throws', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      throw new Error('ECONNRESET')
    }
    const sleeps: number[] = []
    const client = new RegistryClient(HUB, fetchImpl, async (ms) => {
      sleeps.push(ms)
    })
    await expect(client.resolveProduct({ asin: 'B00NET' }))
      .rejects.toThrow(/network error.*after 4 attempts/)
    expect(calls).toBe(4)
    expect(sleeps).toEqual([1_000, 2_000, 4_000])
  })

  it('succeeds after transient 5xx without exhausting retries', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      if (calls < 3) return new Response('busy', { status: 502 })
      return jsonResponse({
        status: 'resolved',
        productId: PRODUCT_ID,
        registryVersion: 1,
        created: false,
        conflictId: null,
      })
    }
    const sleeps: number[] = []
    const client = new RegistryClient(HUB, fetchImpl, async (ms) => {
      sleeps.push(ms)
    })
    await expect(client.resolveProduct({ asin: 'B00OK' }))
      .resolves.toMatchObject({ productId: PRODUCT_ID, created: false })
    expect(calls).toBe(3)
    expect(sleeps).toEqual([1_000, 2_000])
  })

  it('rejects a non-canonical productId in a 200 response', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({
      status: 'resolved',
      productId: 'not-a-prd',
      registryVersion: 1,
      created: false,
      conflictId: null,
    })
    const client = new RegistryClient(HUB, fetchImpl, async () => {})
    await expect(client.resolveProduct({ asin: 'B00BAD' }))
      .rejects.toThrow(/non-canonical productId/)
  })
})
