import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_TRACKED_PRODUCTS,
  archiveProduct,
  bulkCreateProducts,
  countByTier,
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
  isObservation,
  OBSERVATION_SQL,
  latestObservationForAsin,
  latestSnapshotForAsin,
  latestTwoForAsin,
  listActiveAlerts,
  listProducts,
  listSeedQueries,
  listUnreadAlertEvents,
  markAlertEventRead,
  maxPriceInWindow,
  selectSweepAsins,
  seriesForAsin,
  setProductTier,
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
      coldSweepCursor: 0,
      coldSweepDivisor: 1,
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

  it('rejects corpus additions beyond the MAX_TRACKED_PRODUCTS cap', () => {
    const database = openDatabase(':memory:')
    db = database
    // Seed exactly to the cap, whatever it currently is (raised 5,000 -> 20,000
    // for the shoe-variation expansion), so this test tracks the constant
    // instead of pinning a number that changes with corpus policy.
    database.prepare(`
      WITH RECURSIVE ids(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM ids WHERE value < ?
      )
      INSERT INTO products (asin, addedAt, source)
      SELECT printf('A%09d', value), '2026-01-01T00:00:00.000Z', 'import' FROM ids
    `).run(MAX_TRACKED_PRODUCTS)
    // Assert the ACTUAL number appears, not just the phrase "corpus is
    // capped" — a loose regex previously hid a stale 5,000 in the message
    // while the real constant had drifted to 20,000.
    expect(() => createProduct(database, { asin: 'ONE_TOO_MANY' }))
      .toThrow(new RegExp(`corpus is capped at ${MAX_TRACKED_PRODUCTS} products`))
  })

  it('does not count archived products against the cap', () => {
    const database = openDatabase(':memory:')
    db = database
    database.prepare(`
      WITH RECURSIVE ids(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM ids WHERE value < ?
      )
      INSERT INTO products (asin, addedAt, source, isArchived)
      SELECT printf('A%09d', value), '2026-01-01T00:00:00.000Z', 'import', 1 FROM ids
    `).run(MAX_TRACKED_PRODUCTS)
    // Every row is archived, so a fresh product should still fit under the cap.
    expect(createProduct(database, { asin: 'ROOM_TO_SPARE' })?.asin).toBe('ROOM_TO_SPARE')
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

  it('isObservation is false only for an all-null miss row', () => {
    expect(isObservation({
      buyBoxPrice: null, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: null, fbaOfferCount: null, salesRank: null,
    })).toBe(false)
    expect(isObservation({
      buyBoxPrice: null, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: 0, fbaOfferCount: 0, salesRank: null,
    })).toBe(true)
    expect(isObservation({
      buyBoxPrice: null, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: null, fbaOfferCount: null, salesRank: 500,
    })).toBe(true)
  })

  it('latestTwoForAsin skips miss rows and returns the two most recent real observations', () => {
    db = openDatabase(':memory:')
    insertSnapshot(db, {
      asin: 'A1', ts: '2026-01-01T00:00:00.000Z', buyBoxPrice: 30,
      lowestNewPrice: null, lowestFbaPrice: null, offerCount: 2,
      fbaOfferCount: 1, salesRank: 100, rankCategory: 'Tools',
    })
    // Miss row sandwiched between two real observations: SP-API chunk
    // failure inserted a row with every metric null (DESIGN.md:77-79
    // requires the insert; it must not be readable back as a real value).
    insertSnapshot(db, {
      asin: 'A1', ts: '2026-01-02T00:00:00.000Z', buyBoxPrice: null,
      lowestNewPrice: null, lowestFbaPrice: null, offerCount: null,
      fbaOfferCount: null, salesRank: null, rankCategory: null,
    })
    insertSnapshot(db, {
      asin: 'A1', ts: '2026-01-03T00:00:00.000Z', buyBoxPrice: 20,
      lowestNewPrice: null, lowestFbaPrice: null, offerCount: 2,
      fbaOfferCount: 1, salesRank: 90, rankCategory: 'Tools',
    })
    // latestSnapshotForAsin (unfiltered) sees the miss row's ts is not the
    // latest here, but latestTwoForAsin must skip it entirely regardless
    // of position, returning the two real observations.
    const pair = latestTwoForAsin(db, 'A1')
    expect(pair.map((s) => s.ts)).toEqual(['2026-01-03T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])
    expect(pair.map((s) => s.buyBoxPrice)).toEqual([20, 30])
    expect(latestObservationForAsin(db, 'A1')?.ts).toBe('2026-01-03T00:00:00.000Z')
  })

  it('latestObservationForAsin returns undefined when only a miss row exists', () => {
    db = openDatabase(':memory:')
    insertSnapshot(db, {
      asin: 'A1', ts: '2026-01-01T00:00:00.000Z', buyBoxPrice: null,
      lowestNewPrice: null, lowestFbaPrice: null, offerCount: null,
      fbaOfferCount: null, salesRank: null, rankCategory: null,
    })
    expect(latestSnapshotForAsin(db, 'A1')).toBeDefined()
    expect(latestObservationForAsin(db, 'A1')).toBeUndefined()
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

describe('tier-aware sweep scheduling', () => {
  let db: DatabaseHandle | undefined
  let temporaryDirectory: string | undefined

  afterEach(() => {
    db?.close()
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('round-trips setProductTier and countByTier', () => {
    db = openDatabase(':memory:')
    createProduct(db, { asin: 'A1' })
    createProduct(db, { asin: 'A2' })
    createProduct(db, { asin: 'A3', isArchived: true })
    expect(countByTier(db)).toEqual({ hot: 0, cold: 2 })

    setProductTier(db, ['A1', 'A3'], 'hot')
    expect(getProductByAsin(db, 'A1')?.tier).toBe('hot')
    expect(getProductByAsin(db, 'A2')?.tier).toBe('cold')
    expect(getProductByAsin(db, 'A3')?.tier).toBe('hot')
    // A3 is archived, so it drops out of the active-only tier counts.
    expect(countByTier(db)).toEqual({ hot: 1, cold: 1 })
  })

  it('rotates cold ASINs across a full divisor cycle with no starvation, while hot ASINs sweep every cycle', () => {
    db = openDatabase(':memory:')
    const hotAsins = ['H1', 'H2']
    const coldAsins = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']
    for (const asin of [...hotAsins, ...coldAsins]) createProduct(db, { asin })
    setProductTier(db, hotAsins, 'hot')

    let cursor = 0
    const coldSweptAcrossCycles: string[] = []
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const selection = selectSweepAsins(db, { divisor: 4, cursor })
      for (const hot of hotAsins) expect(selection.asins).toContain(hot)
      coldSweptAcrossCycles.push(...selection.asins.filter((asin) => coldAsins.includes(asin)))
      cursor = selection.nextCursor
    }

    // No-starvation gate: the union of cold ASINs swept across one full
    // rotation equals the entire cold set, with no ASIN swept twice.
    expect(coldSweptAcrossCycles.sort()).toEqual([...coldAsins].sort())
    expect(new Set(coldSweptAcrossCycles).size).toBe(coldAsins.length)
    expect(cursor).toBe(0)
  })

  it('sweeps all cold ASINs every cycle when divisor <= 1 (behavior-preserving default)', () => {
    db = openDatabase(':memory:')
    const coldAsins = ['C1', 'C2', 'C3']
    for (const asin of coldAsins) createProduct(db, { asin })
    for (const divisor of [0, 1, -3]) {
      const selection = selectSweepAsins(db, { divisor, cursor: 0 })
      expect(selection.asins.sort()).toEqual([...coldAsins].sort())
      expect(selection.nextCursor).toBe(0)
    }
  })

  it('never sweeps archived products in either tier', () => {
    db = openDatabase(':memory:')
    const hot = createProduct(db, { asin: 'HOT1' })
    const cold = createProduct(db, { asin: 'COLD1' })
    setProductTier(db, ['HOT1'], 'hot')
    archiveProduct(db, hot.id)
    archiveProduct(db, cold.id)

    const selection = selectSweepAsins(db, { divisor: 1, cursor: 0 })
    expect(selection.asins).toEqual([])
    expect(selection.hotCount).toBe(0)
    expect(selection.coldCount).toBe(0)
  })

  it('handles a corpus smaller than the divisor without crashing, covering every ASIN within divisor cycles', () => {
    db = openDatabase(':memory:')
    createProduct(db, { asin: 'C1' })
    createProduct(db, { asin: 'C2' })

    let cursor = 0
    const seen = new Set<string>()
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const selection = selectSweepAsins(db, { divisor: 4, cursor })
      for (const asin of selection.asins) seen.add(asin)
      cursor = selection.nextCursor
    }
    expect(seen).toEqual(new Set(['C1', 'C2']))
  })

  it('adds the tier and cold-sweep settings columns idempotently across repeated opens', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'custos-tier-'))
    const databasePath = join(temporaryDirectory, 'custos.db')
    const first = openDatabase(databasePath)
    createProduct(first, { asin: 'A1' })
    first.close()

    // Reopening an existing database must be a no-op for the ALTER migrations.
    db = openDatabase(databasePath)
    expect(getProductByAsin(db, 'A1')?.tier).toBe('cold')
    expect(getSettings(db)).toMatchObject({ coldSweepCursor: 0, coldSweepDivisor: 1 }) // tiering is opt-in
  })
})

describe('observation predicate consistency', () => {
  let db: DatabaseHandle | undefined
  afterEach(() => db?.close())

  // isObservation() and OBSERVATION_SQL are the same rule expressed twice —
  // once in JS, once in SQL. Nothing structurally keeps them in sync, and a
  // constant drifting from its twin is exactly the bug that let the corpus
  // cap say 5,000 while the real limit was 20,000. This asserts every metric
  // column agrees in BOTH, so adding a column to snapshots without updating
  // both expressions fails loudly here.
  const METRICS = [
    'buyBoxPrice', 'lowestNewPrice', 'lowestFbaPrice',
    'offerCount', 'fbaOfferCount', 'salesRank',
  ] as const

  it('JS and SQL agree for every metric column, and on the all-null miss row', () => {
    const database = openDatabase(':memory:')
    db = database
    const nulls = {
      buyBoxPrice: null, lowestNewPrice: null, lowestFbaPrice: null,
      offerCount: null, fbaOfferCount: null, salesRank: null,
    }
    const sqlSaysObservation = (asin: string): boolean =>
      (database.prepare(
        `SELECT COUNT(*) AS c FROM snapshots WHERE asin = ? AND ${OBSERVATION_SQL}`,
      ).get(asin) as { c: number }).c > 0

    METRICS.forEach((metric, index) => {
      const asin = `OBS${index}`
      const row = { ...nulls, [metric]: 1 }
      insertSnapshot(database, {
        asin, ts: `2026-01-0${index + 1}T00:00:00.000Z`, rankCategory: null, ...row,
      })
      expect(isObservation(row), `${metric} (JS)`).toBe(true)
      expect(sqlSaysObservation(asin), `${metric} (SQL)`).toBe(true)
    })

    insertSnapshot(database, {
      asin: 'MISSROW', ts: '2026-02-01T00:00:00.000Z', rankCategory: 'Tools', ...nulls,
    })
    expect(isObservation(nulls)).toBe(false)
    expect(sqlSaysObservation('MISSROW')).toBe(false)
  })
})
