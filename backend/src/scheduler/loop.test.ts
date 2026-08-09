import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProduct, getSettings, setProductTier, updateSettings } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import type { CustosApiClient } from '../spapi/client.js'
import { startScheduler } from './loop.js'

describe('startScheduler', () => {
  let db: DatabaseHandle | undefined

  afterEach(() => {
    vi.useRealTimers()
    db?.close()
  })

  it('reports status, records the sweep summary, and clamps interval to 15 minutes', async () => {
    vi.useFakeTimers()
    db = openDatabase(':memory:')
    createProduct(db, { asin: 'A1' })
    updateSettings(db, { sweepIntervalMin: 1 })
    const client: CustosApiClient = {
      getOffers: vi.fn(async () => []),
      getCatalog: vi.fn(async () => []),
      searchByKeywords: vi.fn(async () => ({ items: [], nextPageToken: null })),
      ping: vi.fn(async () => ({ ok: true, detail: 'test' })),
    }
    const scheduler = startScheduler(db, () => client, {
      now: () => new Date('2026-04-01T00:00:00.000Z'),
    })

    await vi.waitFor(() => expect(scheduler.getStatus().lastSummary).not.toBeNull())
    expect(scheduler.getStatus()).toMatchObject({
      running: true,
      sweepRunning: false,
      lastError: null,
      lastSummary: { asins: 1, bothMissed: 1, alertsFired: 0 },
    })
    expect(Date.parse(scheduler.getStatus().nextRunAt as string) - Date.now())
      .toBeGreaterThanOrEqual(15 * 60_000 - 100)
    scheduler.stop()
    expect(scheduler.getStatus()).toMatchObject({ running: false, nextRunAt: null })
  })

  it('advances the cold-sweep cursor after a successful cycle and holds it after a failed one', async () => {
    vi.useFakeTimers()
    db = openDatabase(':memory:')
    createProduct(db, { asin: 'H1' })
    createProduct(db, { asin: 'C1' })
    createProduct(db, { asin: 'C2' })
    setProductTier(db, ['H1'], 'hot')
    updateSettings(db, { sweepIntervalMin: 1, coldSweepDivisor: 2, coldSweepCursor: 0 })

    const okClient: CustosApiClient = {
      getOffers: vi.fn(async () => []),
      getCatalog: vi.fn(async () => []),
      searchByKeywords: vi.fn(async () => ({ items: [], nextPageToken: null })),
      ping: vi.fn(async () => ({ ok: true, detail: 'test' })),
    }
    const okScheduler = startScheduler(db, () => okClient, {
      now: () => new Date('2026-04-01T00:00:00.000Z'),
    })
    await vi.waitFor(() => expect(okScheduler.getStatus().lastSummary).not.toBeNull())
    expect(okScheduler.getStatus().lastSummary).toMatchObject({ hotCount: 1, coldSliceCount: 1 })
    expect(getSettings(db).coldSweepCursor).toBe(1)
    okScheduler.stop()

    const failingClient: CustosApiClient = {
      getOffers: vi.fn(async () => {
        throw new Error('SP-API unavailable')
      }),
      getCatalog: vi.fn(async () => []),
      searchByKeywords: vi.fn(async () => ({ items: [], nextPageToken: null })),
      ping: vi.fn(async () => ({ ok: true, detail: 'test' })),
    }
    const failingScheduler = startScheduler(db, () => failingClient, {
      now: () => new Date('2026-04-01T01:00:00.000Z'),
    })
    await vi.waitFor(() => expect(failingScheduler.getStatus().lastError).not.toBeNull())
    expect(getSettings(db).coldSweepCursor).toBe(1)
    failingScheduler.stop()
  })
})
