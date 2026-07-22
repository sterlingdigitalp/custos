import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'

import { createProduct } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import {
  KeepaClient,
  KeepaFatalRequestError,
  KeepaTokensExhaustedError,
} from './client.js'
import { buildKeepaWorkList, runKeepaBackfill } from './backfill.js'

function productPayload(asin: string, amazonPairs: number[] = [3_628_244, 7995]): Record<string, unknown> {
  const csv: Array<number[] | null> = new Array(36).fill(null)
  csv[0] = amazonPairs
  return { asin, domainId: 1, csv }
}

function mockClient(
  handler: (asins: string[]) => Promise<{
    products: Array<Record<string, unknown> | null>
    tokensLeft?: number
    refillIn?: number
    refillRate?: number
    tokensConsumed?: number
  }>,
): KeepaClient {
  return {
    getProducts: async (asins: string[]) => {
      const result = await handler(asins)
      return {
        products: result.products,
        tokensLeft: result.tokensLeft ?? 100,
        refillIn: result.refillIn ?? 0,
        refillRate: result.refillRate ?? 1,
        tokensConsumed: result.tokensConsumed ?? result.products.filter(Boolean).length,
      }
    },
  } as unknown as KeepaClient
}

describe('buildKeepaWorkList', () => {
  let db: DatabaseHandle
  beforeEach(() => { db = openDatabase(':memory:') })
  afterEach(() => db.close())

  it('orders priority ASINs first then active products; skips done/not_found', () => {
    createProduct(db, { asin: 'B0ACTIVE01', source: 'manual' })
    createProduct(db, { asin: 'B0ACTIVE02', source: 'manual' })
    createProduct(db, { asin: 'B0ARCHIVED', source: 'manual', isArchived: true })
    db.prepare(`
      INSERT INTO keepa_checkpoint (asin, status, tokens_spent, last_error, updated_at)
      VALUES ('B0ACTIVE02', 'done', 1, NULL, '2026-01-01T00:00:00.000Z')
    `).run()

    const work = buildKeepaWorkList(db, ['B0PRIORITY', 'B0ACTIVE01', 'B0ACTIVE02'])
    expect(work[0]).toBe('B0PRIORITY')
    expect(work).toContain('B0ACTIVE01')
    expect(work).not.toContain('B0ACTIVE02')
    expect(work).not.toContain('B0ARCHIVED')
  })
})

describe('runKeepaBackfill', () => {
  let db: DatabaseHandle
  beforeEach(() => { db = openDatabase(':memory:') })
  afterEach(() => db.close())

  it('writes raw+points+checkpoint per ASIN and resumes with zero spend', async () => {
    createProduct(db, { asin: 'B0TEST0001', source: 'manual' })
    createProduct(db, { asin: 'B0TEST0002', source: 'manual' })

    let calls = 0
    const client = mockClient(async (asins) => {
      calls += 1
      return {
        products: asins.map((asin) => productPayload(asin)),
        tokensConsumed: asins.length,
        tokensLeft: 100,
      }
    })

    const first = await runKeepaBackfill(db, client, { batchSize: 100 })
    expect(first).toMatchObject({
      attempted: 2,
      done: 2,
      notFound: 0,
      failed: 0,
      tokensSpent: 2,
    })
    expect(calls).toBe(1)

    const raw = db.prepare('SELECT asin, domain, tokens_cost, payload FROM keepa_raw ORDER BY asin').all() as Array<{
      asin: string
      domain: number
      tokens_cost: number
      payload: Buffer
    }>
    expect(raw).toHaveLength(2)
    const decoded = JSON.parse(gunzipSync(raw[0]!.payload).toString('utf8')) as { asin: string }
    expect(decoded.asin).toBe(raw[0]!.asin)

    const points = db.prepare(
      'SELECT COUNT(*) AS n FROM keepa_points WHERE asin = ? AND metric = ?',
    ).get('B0TEST0001', 'amazon') as { n: number }
    expect(points.n).toBe(1)

    const second = await runKeepaBackfill(db, client, { batchSize: 100 })
    expect(second).toMatchObject({
      attempted: 0,
      done: 0,
      notFound: 0,
      failed: 0,
      tokensSpent: 0,
    })
    expect(calls).toBe(1) // no new requests
  })

  it('marks missing response products as not_found', async () => {
    createProduct(db, { asin: 'B0MISSING01', source: 'manual' })
    createProduct(db, { asin: 'B0PRESENT01', source: 'manual' })

    const client = mockClient(async () => ({
      products: [productPayload('B0PRESENT01'), null],
      tokensConsumed: 1,
    }))

    const summary = await runKeepaBackfill(db, client)
    expect(summary.done).toBe(1)
    expect(summary.notFound).toBe(1)

    const rows = db.prepare(
      'SELECT asin, status FROM keepa_checkpoint ORDER BY asin',
    ).all() as Array<{ asin: string; status: string }>
    expect(rows).toEqual([
      { asin: 'B0MISSING01', status: 'not_found' },
      { asin: 'B0PRESENT01', status: 'done' },
    ])
  })

  it('keeps completed ASINs when a later ASIN in the batch throws', async () => {
    createProduct(db, { asin: 'B0OK000001', source: 'manual' })
    createProduct(db, { asin: 'B0BOOM0001', source: 'manual' })

    const client = mockClient(async () => ({
      products: [
        productPayload('B0OK000001'),
        // invalid csv shape will still normalize empty; force throw via Proxy
        new Proxy(productPayload('B0BOOM0001'), {
          get(target, prop, receiver) {
            if (prop === 'csv') throw new Error('mid-asin boom')
            return Reflect.get(target, prop, receiver)
          },
        }),
      ],
      tokensConsumed: 2,
    }))

    const summary = await runKeepaBackfill(db, client, {
      priorityAsins: ['B0OK000001', 'B0BOOM0001'],
      batchSize: 2,
    })
    expect(summary.done).toBe(1)
    expect(summary.failed).toBe(1)

    const ok = db.prepare(
      "SELECT status FROM keepa_checkpoint WHERE asin = 'B0OK000001'",
    ).get() as { status: string }
    expect(ok.status).toBe('done')
    expect(db.prepare('SELECT COUNT(*) AS n FROM keepa_raw').get()).toEqual({ n: 1 })
  })

  it('paces when tokensLeft is below estimated next-batch cost', async () => {
    createProduct(db, { asin: 'B0PACE0001', source: 'manual' })
    createProduct(db, { asin: 'B0PACE0002', source: 'manual' })
    createProduct(db, { asin: 'B0PACE0003', source: 'manual' })

    const sleeps: number[] = []
    let call = 0
    const client = mockClient(async (asins) => {
      call += 1
      // After first batch of 1, leave tokensLeft low so second batch paces.
      return {
        products: asins.map((asin) => productPayload(asin)),
        tokensConsumed: asins.length * 2, // 2 tokens/ASIN average
        tokensLeft: call === 1 ? 0 : 100,
        refillRate: 1, // 1 token per minute
      }
    })

    await runKeepaBackfill(db, client, {
      batchSize: 1,
      sleep: async (ms) => { sleeps.push(ms) },
    })

    // deficit for next batch (1 asin * 2 tokens) - 0 left = 2 tokens
    // waitMinutes = 2 / 1 = 2 → 120_000ms + 5_000 = 125_000
    expect(sleeps.length).toBeGreaterThanOrEqual(1)
    expect(sleeps[0]).toBe(125_000)
  })

  it('sleeps refillIn+5s on tokens-exhausted then retries batch', async () => {
    createProduct(db, { asin: 'B0TOKEN001', source: 'manual' })
    const sleeps: number[] = []
    let call = 0
    const realClient = {
      getProducts: async (asins: string[]) => {
        call += 1
        if (call === 1) {
          throw new KeepaTokensExhaustedError('empty', 429, 30_000)
        }
        return {
          products: asins.map((asin) => productPayload(asin)),
          tokensLeft: 50,
          refillIn: 0,
          refillRate: 1,
          tokensConsumed: 1,
        }
      },
    } as unknown as KeepaClient

    const summary = await runKeepaBackfill(db, realClient, {
      sleep: async (ms) => { sleeps.push(ms) },
    })
    expect(summary.done).toBe(1)
    expect(sleeps).toContain(35_000) // 30000 + 5000
    expect(call).toBe(2)
  })

  it('marks batch failed on fatal request error', async () => {
    createProduct(db, { asin: 'B0FATAL001', source: 'manual' })
    const client = {
      getProducts: async () => {
        throw new KeepaFatalRequestError('bad asin', 400)
      },
    } as unknown as KeepaClient

    const summary = await runKeepaBackfill(db, client)
    expect(summary.failed).toBe(1)
    expect(summary.done).toBe(0)
    const row = db.prepare(
      'SELECT status, last_error FROM keepa_checkpoint WHERE asin = ?',
    ).get('B0FATAL001') as { status: string; last_error: string }
    expect(row.status).toBe('failed')
    expect(row.last_error).toMatch(/bad asin/)
  })

  it('honors limit for smoke runs', async () => {
    for (let i = 0; i < 5; i += 1) {
      createProduct(db, { asin: `B0LIM${String(i).padStart(5, '0')}`, source: 'manual' })
    }
    const seen: string[] = []
    const client = mockClient(async (asins) => {
      seen.push(...asins)
      return { products: asins.map((a) => productPayload(a)), tokensConsumed: asins.length }
    })
    const summary = await runKeepaBackfill(db, client, { limit: 2 })
    expect(summary.attempted).toBe(2)
    expect(summary.done).toBe(2)
    expect(seen).toHaveLength(2)
  })

  it('re-normalizes on re-fetch (delete+reinsert points)', async () => {
    createProduct(db, { asin: 'B0REFETCH1', source: 'manual' })
    let generation = 0
    const client = mockClient(async (asins) => {
      generation += 1
      const value = generation === 1 ? 1000 : 2000
      return {
        products: asins.map((asin) => productPayload(asin, [3_628_244, value])),
        tokensConsumed: 1,
      }
    })

    await runKeepaBackfill(db, client)
    // Force re-run by clearing checkpoint only
    db.prepare("DELETE FROM keepa_checkpoint WHERE asin = 'B0REFETCH1'").run()
    await runKeepaBackfill(db, client)

    const points = db.prepare(
      "SELECT value FROM keepa_points WHERE asin = 'B0REFETCH1' AND metric = 'amazon'",
    ).all() as Array<{ value: number }>
    expect(points).toEqual([{ value: 2000 }])
  })
})
