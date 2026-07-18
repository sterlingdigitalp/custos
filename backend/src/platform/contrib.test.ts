/**
 * History contribution builder + HTTP endpoints (P3).
 * validateContribution is a replica of andrew's PlatformCustosAdapter
 * validator (andrew/src/server/adapters.ts ~108-129) so every outcome is
 * proven against the real consumer contract.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newId, type Contribution } from '@platform/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildServer } from '../api/server.js'
import {
  insertSnapshot,
  updateSettings,
  upsertProductMapping,
} from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import { registerFrontend } from '../index.js'
import type { CustosApiClient } from '../spapi/client.js'
import { buildHistoryContribution } from './contrib.js'

const NOW = new Date('2026-07-17T12:00:00.000Z')
const ASIN = 'B00CONTRIB1'
const PRODUCT_ID = newId('prd', 700_000)

// --- andrew validateContribution replica (adapters.ts:108-129) ---

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function validateContribution(
  source: string,
  value: unknown,
): Contribution<Record<string, unknown>> {
  const body = record(value)
  if (
    !body
    || !['fresh', 'stale', 'unavailable', 'absent', 'error'].includes(String(body.status))
    || body.source !== source
    || typeof body.asOf !== 'string'
    || !Number.isFinite(Date.parse(body.asOf))
  ) {
    throw new TypeError(`${source} returned a malformed contribution envelope`)
  }
  const status = body.status as Contribution<Record<string, unknown>>['status']
  const data = body.data
  const reasonCode = body.reasonCode
  if ((status === 'fresh' || status === 'stale') && !record(data)) {
    throw new TypeError(`${source} contribution must contain data`)
  }
  if (
    (status === 'unavailable' || status === 'error')
    && (data !== null || typeof reasonCode !== 'string')
  ) {
    throw new TypeError(`${source} ${status} contribution has invalid null/reason semantics`)
  }
  if (status === 'absent' && (data !== null || (reasonCode !== null && reasonCode !== undefined))) {
    throw new TypeError(`${source} absent contribution has invalid semantics`)
  }
  if (
    body.sourceSequence !== null
    && body.sourceSequence !== undefined
    && !Number.isSafeInteger(body.sourceSequence)
  ) {
    throw new TypeError(`${source} contribution has invalid sourceSequence`)
  }
  return body as unknown as Contribution<Record<string, unknown>>
}

function contributionPayload(source: 'history', value: unknown): unknown {
  const wrapper = record(value)
  if (source === 'history' && wrapper && 'history' in wrapper) return wrapper.history
  return value
}

function seedMapping(db: DatabaseHandle, asin = ASIN, productId = PRODUCT_ID) {
  return upsertProductMapping(db, {
    asin,
    canonicalProductId: productId,
    registryVersion: 1,
    createdByUs: true,
    resolvedAt: '2026-07-01T00:00:00.000Z',
  })
}

function seedSnapshot(
  db: DatabaseHandle,
  asin: string,
  ts: string,
  opts: {
    buyBox?: number | null
    rank?: number | null
    offers?: number | null
    fbaOffers?: number | null
  } = {},
) {
  return insertSnapshot(db, {
    asin,
    ts,
    buyBoxPrice: opts.buyBox ?? 19.99,
    lowestNewPrice: 18.0,
    lowestFbaPrice: 19.5,
    offerCount: opts.offers ?? 4,
    fbaOfferCount: opts.fbaOffers ?? 2,
    salesRank: opts.rank ?? 1200,
    rankCategory: 'Home',
  })
}

function seedRollup(
  db: DatabaseHandle,
  asin: string,
  date: string,
  opts: {
    buyboxMedianCents?: number | null
    buyboxMinCents?: number | null
    buyboxMaxCents?: number | null
    rankMedian?: number | null
    rankMin?: number | null
    rankMax?: number | null
  } = {},
) {
  db.prepare(`
    INSERT INTO daily_rollups (
      asin, date, snapshot_count,
      buybox_median_cents, buybox_min_cents, buybox_max_cents,
      lowest_new_median_cents, lowest_fba_median_cents,
      offer_count_median, fba_offer_count_median,
      sales_rank_median, sales_rank_min, sales_rank_max,
      rank_category, estimated_sales, emitted_event_id, computed_at
    ) VALUES (
      @asin, @date, 1,
      @buyboxMedianCents, @buyboxMinCents, @buyboxMaxCents,
      NULL, NULL, NULL, NULL,
      @rankMedian, @rankMin, @rankMax,
      'Home', 0, NULL, @computedAt
    )
  `).run({
    asin,
    date,
    buyboxMedianCents: opts.buyboxMedianCents ?? 2000,
    buyboxMinCents: opts.buyboxMinCents ?? 1800,
    buyboxMaxCents: opts.buyboxMaxCents ?? 2200,
    rankMedian: opts.rankMedian ?? 1000,
    rankMin: opts.rankMin ?? 800,
    rankMax: opts.rankMax ?? 1500,
    computedAt: `${date}T23:00:00.000Z`,
  })
}

function seedSpike(db: DatabaseHandle, asin: string, detectedAt: string) {
  db.prepare(`
    INSERT INTO history_spikes (
      asin, detected_at, rank_before, rank_after, rank_category,
      improvement_percent, emitted_event_id
    ) VALUES (?, ?, 5000, 1000, 'Home', 80.0, NULL)
  `).run(asin, detectedAt)
}

describe('buildHistoryContribution', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
    updateSettings(db, { sweepIntervalMin: 60 })
  })
  afterEach(() => db.close())

  it('returns absent for unknown productId', () => {
    const c = buildHistoryContribution(db, { productId: 'prd_UNKNOWN' }, { now: NOW })
    expect(c.status).toBe('absent')
    expect(() => validateContribution('history', c)).not.toThrow()
    expect(c.data).toBeNull()
    expect(c.source).toBe('history')
  })

  it('returns absent for unmapped asin', () => {
    const c = buildHistoryContribution(db, { asin: 'B00NOMAP' }, { now: NOW })
    expect(c.status).toBe('absent')
    expect(() => validateContribution('history', c)).not.toThrow()
  })

  it('returns unavailable NEVER_SYNCED when mapped but no snapshots', () => {
    seedMapping(db)
    const c = buildHistoryContribution(db, { productId: PRODUCT_ID }, { now: NOW })
    expect(c.status).toBe('unavailable')
    expect(c.reasonCode).toBe('NEVER_SYNCED')
    expect(c.data).toBeNull()
    expect(() => validateContribution('history', c)).not.toThrow()
  })

  it('returns fresh with normative fields, 90d/30d windows, and sourceSequence', () => {
    seedMapping(db)
    // Fresh: snapshot 30 min ago, interval 60 → 2× = 120 min window
    const snap1 = seedSnapshot(db, ASIN, '2026-07-17T11:30:00.000Z', { buyBox: 21.5, rank: 900 })
    const snap2 = seedSnapshot(db, ASIN, '2026-07-17T11:45:00.000Z', {
      buyBox: 19.99, rank: 850, offers: 5, fbaOffers: 3,
    })

    // 90d window ends 2026-07-17; start = 2026-04-19 (89 days back)
    // Three buybox medians for even/odd median check: 1000, 2000, 3000 → median 2000
    seedRollup(db, ASIN, '2026-07-15', {
      buyboxMedianCents: 1000, buyboxMinCents: 900, buyboxMaxCents: 1100,
      rankMedian: 2000, rankMin: 1800, rankMax: 2200,
    })
    seedRollup(db, ASIN, '2026-07-16', {
      buyboxMedianCents: 3000, buyboxMinCents: 2800, buyboxMaxCents: 3200,
      rankMedian: 1000, rankMin: 900, rankMax: 1200,
    })
    seedRollup(db, ASIN, '2026-07-17', {
      buyboxMedianCents: 2000, buyboxMinCents: 1500, buyboxMaxCents: 2500,
      rankMedian: 1500, rankMin: 1000, rankMax: 2000,
    })
    // Outside 90d window — must be ignored
    seedRollup(db, ASIN, '2026-04-01', {
      buyboxMedianCents: 99999, buyboxMinCents: 1, buyboxMaxCents: 99999,
      rankMedian: 1, rankMin: 1, rankMax: 1,
    })

    // Spikes: two in 30d, one outside
    seedSpike(db, ASIN, '2026-07-10T10:00:00.000Z')
    seedSpike(db, ASIN, '2026-07-16T08:00:00.000Z')
    seedSpike(db, ASIN, '2026-05-01T08:00:00.000Z') // outside 30d

    const c = buildHistoryContribution(db, { productId: PRODUCT_ID }, { now: NOW })
    expect(() => validateContribution('history', c)).not.toThrow()
    expect(c.status).toBe('fresh')
    expect(c.asOf).toBe('2026-07-17T11:45:00.000Z')
    expect(c.sourceSequence).toBe(snap2.id)
    expect(c.sourceSequence).toBeGreaterThanOrEqual(snap1.id)

    const data = c.data as Record<string, unknown>
    // Normative §11.3 minimum
    expect(data).toHaveProperty('boxMedian90d')
    expect(data).toHaveProperty('estimatedSold30d')
    expect(data.boxMedian90d).toEqual({ amount: '20.00', currency: 'USD' })
    expect(data.estimatedSold30d).toBe(2)
    expect(data.rankDrops30d).toBe(2)

    expect(data.currentBuyBox).toEqual({ amount: '19.99', currency: 'USD' })
    expect(data.currentRank).toBe(850)
    expect(data.offerCount).toBe(5)
    expect(data.fbaOfferCount).toBe(3)
    expect(data.snapshotDays90d).toBe(3)

    const priceSeries = data.priceSeries as Array<{ date: string; buyBox: unknown }>
    expect(priceSeries.map((p) => p.date)).toEqual(['2026-07-15', '2026-07-16', '2026-07-17'])
    expect(priceSeries[0]!.buyBox).toEqual({ amount: '10.00', currency: 'USD' })

    const buyBox90d = data.buyBox90d as { min: unknown; max: unknown; median: unknown }
    expect(buyBox90d.min).toEqual({ amount: '9.00', currency: 'USD' })
    expect(buyBox90d.max).toEqual({ amount: '32.00', currency: 'USD' })
    expect(buyBox90d.median).toEqual({ amount: '20.00', currency: 'USD' })

    // rank30d: medians [2000,1000,1500] → integerMedian lower-middle of sorted [1000,1500,2000] = 1500
    // mins min=900, maxs max=2200
    expect(data.rank30d).toEqual({ median: 1500, min: 900, max: 2200 })

    // No invented fields
    expect(data).not.toHaveProperty('estimatedSalesRange')
    expect(data).not.toHaveProperty('sellThrough')
  })

  it('computes boxMedian90d as lower-middle integer-cents median of daily medians', () => {
    seedMapping(db)
    seedSnapshot(db, ASIN, '2026-07-17T11:00:00.000Z')
    // Four medians: 100,200,300,400 → lower-middle = 200
    seedRollup(db, ASIN, '2026-07-14', { buyboxMedianCents: 400 })
    seedRollup(db, ASIN, '2026-07-15', { buyboxMedianCents: 100 })
    seedRollup(db, ASIN, '2026-07-16', { buyboxMedianCents: 300 })
    seedRollup(db, ASIN, '2026-07-17', { buyboxMedianCents: 200 })

    const c = buildHistoryContribution(db, { productId: PRODUCT_ID }, { now: NOW })
    expect(c.status).toBe('fresh')
    expect((c.data as Record<string, unknown>).boxMedian90d).toEqual({
      amount: '2.00', currency: 'USD',
    })
  })

  it('returns stale when latest snapshot is older than 2×sweepInterval', () => {
    seedMapping(db)
    updateSettings(db, { sweepIntervalMin: 60 })
    // 3 hours old > 2×60min
    seedSnapshot(db, ASIN, '2026-07-17T09:00:00.000Z', { buyBox: 10 })
    const c = buildHistoryContribution(db, { productId: PRODUCT_ID }, { now: NOW })
    expect(c.status).toBe('stale')
    expect(c.asOf).toBe('2026-07-17T09:00:00.000Z')
    expect(c.asOf).not.toBe(NOW.toISOString())
    expect(record(c.data)).not.toBeNull()
    expect(typeof c.sourceSequence).toBe('number')
    expect(() => validateContribution('history', c)).not.toThrow()
  })

  it('resolves productId → asin and asin path produces same data shape', () => {
    seedMapping(db)
    seedSnapshot(db, ASIN, '2026-07-17T11:30:00.000Z')
    const byProduct = buildHistoryContribution(db, { productId: PRODUCT_ID }, { now: NOW })
    const byAsin = buildHistoryContribution(db, { asin: ASIN }, { now: NOW })
    expect(byProduct.status).toBe('fresh')
    expect(byAsin.status).toBe('fresh')
    expect(byAsin.data).toEqual(byProduct.data)
    expect(byAsin.sourceSequence).toBe(byProduct.sourceSequence)
  })
})

describe('GET /contrib endpoints', () => {
  let db: DatabaseHandle
  let server: ReturnType<typeof buildServer>
  let savedTokens: string | undefined

  const client: CustosApiClient = {
    getOffers: async () => [],
    getCatalog: async () => [],
    searchByKeywords: async () => ({ items: [], nextPageToken: null }),
    ping: async () => ({ ok: true, detail: 'mock' }),
  }

  beforeEach(() => {
    savedTokens = process.env.HISTORY_CONTRIB_TOKENS
    delete process.env.HISTORY_CONTRIB_TOKENS
    db = openDatabase(':memory:')
    updateSettings(db, { sweepIntervalMin: 60 })
    server = buildServer(db, { client, now: () => NOW })
  })

  afterEach(async () => {
    await server.close()
    db.close()
    if (savedTokens === undefined) delete process.env.HISTORY_CONTRIB_TOKENS
    else process.env.HISTORY_CONTRIB_TOKENS = savedTokens
  })

  it('GET /contrib/products/:productId returns {history} for absent and passes validator', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/contrib/products/prd_UNKNOWN',
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    const body = res.json()
    expect(body).toHaveProperty('history')
    const history = validateContribution('history', contributionPayload('history', body))
    expect(history.status).toBe('absent')
  })

  it('GET /contrib/products/:id fresh path passes validator with sourceSequence', async () => {
    seedMapping(db)
    const snap = seedSnapshot(db, ASIN, '2026-07-17T11:30:00.000Z')
    seedRollup(db, ASIN, '2026-07-16', { buyboxMedianCents: 1500 })
    seedSpike(db, ASIN, '2026-07-15T00:00:00.000Z')

    const res = await server.inject({
      method: 'GET',
      url: `/contrib/products/${PRODUCT_ID}`,
    })
    expect(res.statusCode).toBe(200)
    const history = validateContribution('history', contributionPayload('history', res.json()))
    expect(history.status).toBe('fresh')
    expect(history.sourceSequence).toBe(snap.id)
    expect(history.data).toMatchObject({
      estimatedSold30d: 1,
      rankDrops30d: 1,
    })
    expect(history.data).toHaveProperty('boxMedian90d')
  })

  it('GET /contrib/asins/:asin parity with productId path', async () => {
    seedMapping(db)
    seedSnapshot(db, ASIN, '2026-07-17T11:30:00.000Z')
    const byProduct = await server.inject({
      method: 'GET', url: `/contrib/products/${PRODUCT_ID}`,
    })
    const byAsin = await server.inject({
      method: 'GET', url: `/contrib/asins/${ASIN}`,
    })
    expect(byAsin.statusCode).toBe(200)
    const hProduct = validateContribution('history', contributionPayload('history', byProduct.json()))
    const hAsin = validateContribution('history', contributionPayload('history', byAsin.json()))
    expect(hAsin).toEqual(hProduct)
  })

  it('GET /contrib/products unavailable NEVER_SYNCED passes validator', async () => {
    seedMapping(db)
    const res = await server.inject({
      method: 'GET', url: `/contrib/products/${PRODUCT_ID}`,
    })
    expect(res.statusCode).toBe(200)
    const history = validateContribution('history', contributionPayload('history', res.json()))
    expect(history.status).toBe('unavailable')
    expect(history.reasonCode).toBe('NEVER_SYNCED')
  })

  it('GET /contrib/products stale passes validator', async () => {
    seedMapping(db)
    seedSnapshot(db, ASIN, '2026-07-17T08:00:00.000Z') // 4h ago > 2h
    const res = await server.inject({
      method: 'GET', url: `/contrib/products/${PRODUCT_ID}`,
    })
    const history = validateContribution('history', contributionPayload('history', res.json()))
    expect(history.status).toBe('stale')
    expect(history.asOf).toBe('2026-07-17T08:00:00.000Z')
  })

  it('requires Authorization bearer when HISTORY_CONTRIB_TOKENS is set', async () => {
    await server.close()
    process.env.HISTORY_CONTRIB_TOKENS = ' secret-a , secret-b '
    server = buildServer(db, { client, now: () => NOW })
    seedMapping(db)
    seedSnapshot(db, ASIN, '2026-07-17T11:30:00.000Z')

    const noAuth = await server.inject({
      method: 'GET', url: `/contrib/products/${PRODUCT_ID}`,
    })
    expect(noAuth.statusCode).toBe(401)
    expect(noAuth.json()).toEqual({ error: 'unauthorized' })

    const badAuth = await server.inject({
      method: 'GET',
      url: `/contrib/products/${PRODUCT_ID}`,
      headers: { authorization: 'Bearer wrong' },
    })
    expect(badAuth.statusCode).toBe(401)

    const ok = await server.inject({
      method: 'GET',
      url: `/contrib/products/${PRODUCT_ID}`,
      headers: { authorization: 'Bearer secret-a' },
    })
    expect(ok.statusCode).toBe(200)
    const history = validateContribution('history', contributionPayload('history', ok.json()))
    expect(history.status).toBe('fresh')
  })

  it('SPA fallback never serves text/html for /contrib/* (andrew regression)', async () => {
    const frontendRoot = mkdtempSync(join(tmpdir(), 'custos-spa-'))
    writeFileSync(join(frontendRoot, 'index.html'), '<!doctype html><html><body>SPA</body></html>')
    const registered = await registerFrontend(server, frontendRoot)
    expect(registered).toBe(true)

    // Unknown product → contribution absent (200 JSON), never SPA HTML
    const knownPath = await server.inject({
      method: 'GET',
      url: '/contrib/products/prd_UNKNOWN',
    })
    expect(knownPath.statusCode).toBe(200)
    expect(String(knownPath.headers['content-type'])).toMatch(/application\/json/)
    expect(knownPath.body).not.toMatch(/<!doctype html>/i)
    const history = validateContribution(
      'history',
      contributionPayload('history', knownPath.json()),
    )
    expect(history.status).toBe('absent')

    // Unknown /contrib subpath → 404 JSON, never SPA HTML
    const unknownSub = await server.inject({
      method: 'GET',
      url: '/contrib/nope/xyz',
    })
    expect(unknownSub.statusCode).toBe(404)
    expect(String(unknownSub.headers['content-type'])).toMatch(/application\/json/)
    expect(unknownSub.body).not.toMatch(/<!doctype html>/i)
    expect(unknownSub.json()).toMatchObject({ error: expect.stringContaining('not found') })
  })
})
