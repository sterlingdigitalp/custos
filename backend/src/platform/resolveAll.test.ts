import { newId } from '@platform/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createProduct,
  getMappingByAsin,
  listActiveAsinsMissingMapping,
} from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import type { HubConfig } from './config.js'
import { HubAuthError, RegistryClient, type FetchLike } from './registry.js'
import { resolveAllProducts } from './resolveAll.js'

const HUB: HubConfig = {
  baseUrl: 'http://hub.test',
  token: 'tok',
  accountId: newId('acct', 600_000),
  marketplaceId: 'ATVPDKIKX0DER',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('resolveAllProducts', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('resolves missing ASINs, upserts mappings, and returns a summary', async () => {
    createProduct(db, { asin: 'B00AAA1111', title: 'Alpha' })
    createProduct(db, { asin: 'B00BBB2222', title: 'Beta' })
    createProduct(db, { asin: 'B00CCC3333', title: 'Archived', isArchived: true })

    const prdA = newId('prd', 600_000)
    const prdB = newId('prd', 600_001)
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { asin: string }
      if (body.asin === 'B00AAA1111') {
        return jsonResponse({
          status: 'resolved', productId: prdA, registryVersion: 1, created: true, conflictId: null,
        })
      }
      if (body.asin === 'B00BBB2222') {
        return jsonResponse({
          status: 'resolved', productId: prdB, registryVersion: 2, created: false, conflictId: null,
        })
      }
      return new Response('unexpected', { status: 500 })
    }
    const client = new RegistryClient(HUB, fetchImpl, async () => {})
    const summary = await resolveAllProducts(db, client, {
      paceMs: 0,
      sleep: async () => {},
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    })

    expect(summary).toMatchObject({
      attempted: 2,
      resolved: 2,
      created: 1,
      conflicts: 0,
      failed: 0,
    })
    expect(getMappingByAsin(db, 'B00AAA1111')).toMatchObject({
      canonicalProductId: prdA,
      createdByUs: true,
      registryVersion: 1,
      resolvedAt: '2026-07-17T12:00:00.000Z',
    })
    expect(getMappingByAsin(db, 'B00BBB2222')).toMatchObject({
      canonicalProductId: prdB,
      createdByUs: false,
    })
    expect(listActiveAsinsMissingMapping(db)).toEqual([])
  })

  it('counts conflicts and failures without aborting the batch', async () => {
    createProduct(db, { asin: 'B00OK000001' })
    createProduct(db, { asin: 'B00CONFLICT' })
    createProduct(db, { asin: 'B00FAIL0001' })

    const prdOk = newId('prd', 700_000)
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { asin: string }
      if (body.asin === 'B00OK000001') {
        return jsonResponse({
          status: 'resolved', productId: prdOk, registryVersion: 1, created: false, conflictId: null,
        })
      }
      if (body.asin === 'B00CONFLICT') {
        return jsonResponse({ code: 'PRODUCT_IDENTIFIERS_DISAGREE' }, 409)
      }
      return new Response('nope', { status: 422 })
    }
    const client = new RegistryClient(HUB, fetchImpl, async () => {})
    const summary = await resolveAllProducts(db, client, { paceMs: 0, sleep: async () => {} })

    expect(summary).toMatchObject({
      attempted: 3,
      resolved: 1,
      created: 0,
      conflicts: 1,
      failed: 1,
    })
    expect(summary.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ asin: 'B00CONFLICT', kind: 'conflict' }),
      expect.objectContaining({ asin: 'B00FAIL0001', kind: 'failed' }),
    ]))
    expect(getMappingByAsin(db, 'B00OK000001')?.canonicalProductId).toBe(prdOk)
    expect(getMappingByAsin(db, 'B00CONFLICT')).toBeUndefined()
  })

  it('aborts immediately on HubAuthError without processing remaining ASINs', async () => {
    createProduct(db, { asin: 'B00AUTH0001' })
    createProduct(db, { asin: 'B00LATER001' })

    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return new Response('denied', { status: 401 })
    }
    const client = new RegistryClient(HUB, fetchImpl, async () => {})
    const log = vi.fn()
    await expect(
      resolveAllProducts(db, client, { paceMs: 0, sleep: async () => {}, log }),
    ).rejects.toBeInstanceOf(HubAuthError)
    expect(calls).toBe(1)
    expect(getMappingByAsin(db, 'B00AUTH0001')).toBeUndefined()
    expect(getMappingByAsin(db, 'B00LATER001')).toBeUndefined()
  })
})
