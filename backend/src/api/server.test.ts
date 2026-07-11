import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createAlert,
  createProduct,
  getSettings,
  insertAlertEvent,
  insertSnapshot,
} from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import type { SchedulerStatus } from '../scheduler/loop.js'
import type { CustosApiClient } from '../spapi/client.js'
import { buildServer } from './server.js'

const NOW = new Date('2026-05-10T12:00:00.000Z')
const stoppedStatus: SchedulerStatus = {
  running: false, sweepRunning: false, lastSummary: null, lastError: null, nextRunAt: null,
}

describe('Fastify API', () => {
  let db: DatabaseHandle
  let client: CustosApiClient
  let server: ReturnType<typeof buildServer>

  beforeEach(() => {
    db = openDatabase(':memory:')
    client = {
      getOffers: vi.fn(async (asins: string[]) => asins.map((asin) => ({
        asin, buyBoxPrice: 15, lowestNewPrice: 14, lowestFbaPrice: 16,
        offerCount: 3, fbaOfferCount: 2,
      }))),
      getCatalog: vi.fn(async (asins: string[]) => asins.map((asin) => ({
        asin, title: `Title ${asin}`, brand: 'Acme', imageUrl: null, category: 'Tools',
        salesRank: 100, rankCategory: 'Tools',
      }))),
      searchByKeywords: vi.fn(async () => ({ items: [], nextPageToken: null })),
      ping: vi.fn(async () => ({ ok: true, detail: 'mock' })),
    }
    server = buildServer(db, {
      client,
      scheduler: { getStatus: () => stoppedStatus },
      now: () => NOW,
    })
  })

  afterEach(async () => {
    await server.close()
    db.close()
  })

  it('bulk-adds products with dedupe and exposes history', async () => {
    const added = await server.inject({
      method: 'POST', url: '/api/products', payload: { asins: ['a1', 'A1', 'A2'] },
    })
    expect(added.statusCode).toBe(201)
    expect(added.json()).toMatchObject({ added: 2, skipped: 0 })
    const duplicate = await server.inject({
      method: 'POST', url: '/api/products', payload: { asins: ['A1', 'A3'] },
    })
    expect(duplicate.json()).toMatchObject({ added: 1, skipped: 1 })
    insertSnapshot(db, {
      asin: 'A1', ts: NOW.toISOString(), buyBoxPrice: 12, lowestNewPrice: 11,
      lowestFbaPrice: null, offerCount: 2, fbaOfferCount: 1, salesRank: 50, rankCategory: 'Tools',
    })
    const history = await server.inject({ method: 'GET', url: '/api/products/A1/history?days=90' })
    expect(history.statusCode).toBe(200)
    expect(history.json()).toHaveLength(1)
    expect(history.json()[0]).toMatchObject({ asin: 'A1', buyBoxPrice: 12 })
  })

  it('filters finder by current price and window price drop', async () => {
    createProduct(db, { asin: 'DROP', category: 'Tools' })
    createProduct(db, { asin: 'FLAT', category: 'Tools' })
    const base = {
      lowestNewPrice: null, lowestFbaPrice: null, offerCount: 2,
      fbaOfferCount: 1, salesRank: 100, rankCategory: 'Tools',
    }
    insertSnapshot(db, { ...base, asin: 'DROP', ts: '2026-05-05T12:00:00.000Z', buyBoxPrice: 100 })
    insertSnapshot(db, { ...base, asin: 'DROP', ts: NOW.toISOString(), buyBoxPrice: 70 })
    insertSnapshot(db, { ...base, asin: 'FLAT', ts: '2026-05-05T12:00:00.000Z', buyBoxPrice: 60 })
    insertSnapshot(db, { ...base, asin: 'FLAT', ts: NOW.toISOString(), buyBoxPrice: 58 })

    const response = await server.inject({
      method: 'POST', url: '/api/finder',
      payload: { minPrice: 65, maxPrice: 75, priceDropPercent: 20, windowDays: 7 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveLength(1)
    expect(response.json()[0]).toMatchObject({ asin: 'DROP', currentPrice: 70, priceDropPercent: 30 })
  })

  it('masks settings secrets and preserves masked sentinel patches', async () => {
    const patched = await server.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { lwaClientSecret: 'secret', refreshToken: 'refresh', sweepIntervalMin: 30 },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toMatchObject({
      lwaClientSecret: '***set***', refreshToken: '***set***', sweepIntervalMin: 30,
    })
    await server.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { lwaClientSecret: '***set***', refreshToken: '***set***' },
    })
    expect(getSettings(db)).toMatchObject({ lwaClientSecret: 'secret', refreshToken: 'refresh' })
  })

  it('lists unread events and marks selected ids read', async () => {
    const alert = createAlert(db, { asin: 'A1', ruleType: 'price_below', threshold: 20 })
    const first = insertAlertEvent(db, { alertId: alert.id, asin: 'A1', message: 'first' })
    insertAlertEvent(db, { alertId: alert.id, asin: 'A1', message: 'second', isRead: true })
    const unread = await server.inject({ method: 'GET', url: '/api/alert-events?unread=1' })
    expect(unread.json()).toHaveLength(1)
    const marked = await server.inject({
      method: 'POST', url: '/api/alert-events/mark-read', payload: { ids: [first.id] },
    })
    expect(marked.json()).toEqual({ marked: 1 })
    expect((await server.inject({ method: 'GET', url: '/api/alert-events?unread=1' })).json()).toEqual([])
  })

  it('runs a manual sweep and returns alerts in the summary', async () => {
    createProduct(db, { asin: 'A1' })
    createAlert(db, { asin: 'A1', ruleType: 'price_below', threshold: 20 })
    const response = await server.inject({ method: 'POST', url: '/api/sweep/run' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      asins: 1, offersFetched: 1, catalogFetched: 1, bothMissed: 0, alertsFired: 1,
    })
  })
})
