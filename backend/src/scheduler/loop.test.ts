import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProduct, updateSettings } from '../db/repo.js'
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
})
