import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  archiveProduct,
  bulkCreateProducts,
  createAlert,
  createProduct,
  createSeedQuery,
  deleteAlert,
  deleteSeedQuery,
  getAlertById,
  getProductByAsin,
  getSettings,
  insertAlertEvent,
  insertSnapshot,
  latestSnapshotForAsin,
  latestTwoForAsin,
  listActiveAlerts,
  listProducts,
  listSeedQueries,
  listUnreadAlertEvents,
  markAlertEventRead,
  maxPriceInWindow,
  seriesForAsin,
  updateAlert,
  updateSeedQuery,
  updateSettings,
} from './repo.js'
import { openDatabase, type DatabaseHandle } from './schema.js'

describe('SQLite schema and repositories', () => {
  let db: DatabaseHandle | undefined
  let temporaryDirectory: string | undefined

  afterEach(() => {
    db?.close()
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('creates the schema idempotently with the settings singleton defaults', () => {
    db = openDatabase(':memory:')
    expect(getSettings(db)).toEqual({
      id: 1,
      lwaClientId: null,
      lwaClientSecret: null,
      refreshToken: null,
      marketplaceId: 'ATVPDKIKX0DER',
      region: 'na',
      sweepIntervalMin: 60,
      ntfyTopic: null,
      ntfyServer: 'https://ntfy.sh',
    })
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'snapshots'
    `).all() as Array<{ name: string }>
    expect(indexes.map(({ name }) => name)).toContain('snapshots_asin_ts_idx')
  })

  it('migrates the product source constraint for existing databases', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'custos-schema-'))
    const databasePath = join(temporaryDirectory, 'custos.db')
    const legacy = new Database(databasePath)
    legacy.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asin TEXT NOT NULL UNIQUE,
        title TEXT,
        brand TEXT,
        imageUrl TEXT,
        category TEXT,
        rankCategory TEXT,
        addedAt TEXT NOT NULL,
        source TEXT NOT NULL CHECK (
          source IN ('manual', 'import', 'seed', 'extension', 'aurora')
        ),
        isArchived INTEGER NOT NULL DEFAULT 0 CHECK (isArchived IN (0, 1))
      );
      INSERT INTO products (asin, title, addedAt, source)
      VALUES ('B0LEGACY01', 'Preserved', '2026-01-01T00:00:00.000Z', 'manual');
    `)
    legacy.close()

    db = openDatabase(databasePath)
    expect(getProductByAsin(db, 'B0LEGACY01')).toMatchObject({ id: 1, title: 'Preserved' })
    expect(createProduct(db, { asin: 'B0SELLER01', source: 'selleramp' })).toMatchObject({
      id: 2, source: 'selleramp',
    })
  })

  it('creates, lists, archives, and bulk creates products while skipping existing ASINs', () => {
    db = openDatabase(':memory:')
    const product = createProduct(db, {
      asin: 'A1',
      title: 'First',
      source: 'import',
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(getProductByAsin(db, 'A1')).toEqual(product)
    expect(archiveProduct(db, product.id)?.isArchived).toBe(true)
    expect(listProducts(db)).toEqual([])
    const created = bulkCreateProducts(db, [
      { asin: 'A1', title: 'Ignored duplicate' },
      { asin: 'A2' },
      { asin: 'A3', source: 'seed' },
    ])
    expect(created.map(({ asin }) => asin)).toEqual(['A2', 'A3'])
    expect(listProducts(db, false)).toHaveLength(3)
  })

  it('rejects corpus additions beyond the 5,000-product cap', () => {
    const database = openDatabase(':memory:')
    db = database
    database.exec(`
      WITH RECURSIVE ids(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM ids WHERE value < 5000
      )
      INSERT INTO products (asin, addedAt, source)
      SELECT printf('A%09d', value), '2026-01-01T00:00:00.000Z', 'import' FROM ids
    `)
    expect(() => createProduct(database, { asin: 'ONE_TOO_MANY' }))
      .toThrow('Custos corpus is capped at 5,000 products')
  })

  it('round-trips snapshots and applies time-window queries with price fallback', () => {
    db = openDatabase(':memory:')
    const base = {
      asin: 'A1',
      lowestNewPrice: null,
      lowestFbaPrice: null,
      offerCount: 2,
      fbaOfferCount: 1,
      salesRank: 100,
      rankCategory: 'Tools',
    }
    insertSnapshot(db, { ...base, ts: '2026-01-01T00:00:00.000Z', buyBoxPrice: 30 })
    insertSnapshot(db, {
      ...base,
      ts: '2026-01-02T00:00:00.000Z',
      buyBoxPrice: null,
      lowestNewPrice: 25,
    })
    insertSnapshot(db, { ...base, ts: '2026-01-03T00:00:00.000Z', buyBoxPrice: 20 })
    expect(latestSnapshotForAsin(db, 'A1')?.buyBoxPrice).toBe(20)
    expect(latestTwoForAsin(db, 'A1').map(({ buyBoxPrice }) => buyBoxPrice)).toEqual([20, null])
    expect(seriesForAsin(db, 'A1', 1.5, new Date('2026-01-03T00:00:00.000Z'))).toHaveLength(2)
    expect(maxPriceInWindow(db, 'A1', 36, new Date('2026-01-03T00:00:00.000Z'))).toBe(25)
  })

  it('round-trips alerts, events, seed queries, and settings updates', () => {
    db = openDatabase(':memory:')
    const alert = createAlert(db, { asin: 'A1', ruleType: 'price_below', threshold: 20 })
    expect(alert.cooldownHours).toBe(24)
    expect(updateAlert(db, alert.id, { isActive: false })?.isActive).toBe(false)
    expect(listActiveAlerts(db)).toEqual([])
    expect(getAlertById(db, alert.id)?.threshold).toBe(20)
    const event = insertAlertEvent(db, {
      alertId: alert.id,
      asin: 'A1',
      ts: '2026-01-01T00:00:00.000Z',
      message: 'A1 is cheap at $20.00',
    })
    expect(event).toMatchObject({ delivered: false, isRead: false, deliveryError: null })
    expect(listUnreadAlertEvents(db)).toHaveLength(1)
    expect(markAlertEventRead(db, event.id)?.isRead).toBe(true)
    expect(listUnreadAlertEvents(db)).toEqual([])
    const seed = createSeedQuery(db, { query: 'desk lamp', addedAt: '2026-01-01T00:00:00.000Z' })
    expect(updateSeedQuery(db, seed.id, { lastRunAt: '2026-01-02T00:00:00.000Z' })?.lastRunAt)
      .toBe('2026-01-02T00:00:00.000Z')
    expect(listSeedQueries(db)).toHaveLength(1)
    expect(deleteSeedQuery(db, seed.id)).toBe(true)
    expect(updateSettings(db, { sweepIntervalMin: 15, ntfyTopic: 'custos' }))
      .toMatchObject({ sweepIntervalMin: 15, ntfyTopic: 'custos' })
    expect(deleteAlert(db, alert.id)).toBe(true)
  })
})
