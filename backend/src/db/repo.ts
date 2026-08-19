import type { DatabaseHandle } from './schema.js'

export type ProductSource = 'manual' | 'import' | 'seed' | 'extension' | 'aurora' | 'selleramp'
export type ProductTier = 'hot' | 'cold'
export type AlertRuleType =
  | 'price_below'
  | 'drop_percent'
  | 'back_in_stock'
  | 'rank_below'
  | 'buybox_change'

/**
 * Corpus safety rail. Raised 5,000 -> 20,000 on 2026-08-15 for the shoe-variation
 * expansion (corpus ~11,700). The original 5,000 encoded a sweep-capacity limit:
 * SP-API paces at 2 ASINs/sec, so a FLAT hourly sweep only fits ~7,000. That
 * ceiling no longer binds — tier-aware scheduling sweeps all hot ASINs plus a
 * rotating 1/N slice of cold ones each cycle (see selectSweepAsins). Capacity is
 * now governed by the tier divisor, not this constant; this is just a rail
 * against runaway growth (disk is the real cost — ~0.47 MB of Keepa history per
 * tracked ASIN).
 */
export const MAX_TRACKED_PRODUCTS = 20_000

export interface Product {
  id: number
  asin: string
  title: string | null
  brand: string | null
  imageUrl: string | null
  category: string | null
  rankCategory: string | null
  addedAt: string
  source: ProductSource
  isArchived: boolean
  tier: ProductTier
}

export interface CreateProductInput {
  asin: string
  title?: string | null
  brand?: string | null
  imageUrl?: string | null
  category?: string | null
  rankCategory?: string | null
  addedAt?: string
  source?: ProductSource
  isArchived?: boolean
}

export type ProductCatalogUpdate = Partial<Pick<
  Product,
  'title' | 'brand' | 'imageUrl' | 'category' | 'rankCategory'
>>

export interface Snapshot {
  id: number
  asin: string
  ts: string
  buyBoxPrice: number | null
  lowestNewPrice: number | null
  lowestFbaPrice: number | null
  offerCount: number | null
  fbaOfferCount: number | null
  salesRank: number | null
  rankCategory: string | null
}

export type CreateSnapshotInput = Omit<Snapshot, 'id'>

/**
 * A snapshot row only counts as a real observation when SP-API actually
 * returned SOMETHING for that ASIN. DESIGN.md:77-79 requires a row to be
 * inserted even on a total sweep miss (chunk failure or empty response),
 * but that row has every metric null — it records "we tried and got
 * nothing", not "the product's value is null". Downstream consumers
 * (alerting, spike detection, ceiling analysis, contrib) must treat a
 * miss row as UNKNOWN, never as a real zero/out-of-stock/null value.
 */
export function isObservation(
  row: Pick<
    Snapshot,
    'buyBoxPrice' | 'lowestNewPrice' | 'lowestFbaPrice' | 'offerCount' | 'fbaOfferCount' | 'salesRank'
  >,
): boolean {
  return (
    row.buyBoxPrice !== null ||
    row.lowestNewPrice !== null ||
    row.lowestFbaPrice !== null ||
    row.offerCount !== null ||
    row.fbaOfferCount !== null ||
    row.salesRank !== null
  )
}

/**
 * SQL boolean expression mirroring `isObservation` above, for queries that
 * need to skip miss rows at the database layer rather than filtering in
 * JS. No leading AND/WHERE — splice into a WHERE clause.
 */
export const OBSERVATION_SQL = `(
  buyBoxPrice IS NOT NULL OR lowestNewPrice IS NOT NULL OR lowestFbaPrice IS NOT NULL OR
  offerCount IS NOT NULL OR fbaOfferCount IS NOT NULL OR salesRank IS NOT NULL
)`

export interface Alert {
  id: number
  asin: string
  ruleType: AlertRuleType
  threshold: number | null
  windowHours: number
  isActive: boolean
  cooldownHours: number
  lastFiredAt: string | null
}

export interface CreateAlertInput {
  asin: string
  ruleType: AlertRuleType
  threshold?: number | null
  windowHours?: number
  isActive?: boolean
  cooldownHours?: number
  lastFiredAt?: string | null
}

export type UpdateAlertInput = Partial<Omit<Alert, 'id'>>

export interface AlertEvent {
  id: number
  alertId: number
  asin: string
  ts: string
  message: string
  delivered: boolean
  deliveryError: string | null
  isRead: boolean
}

export interface CreateAlertEventInput {
  alertId: number
  asin: string
  ts?: string
  message: string
  delivered?: boolean
  deliveryError?: string | null
  isRead?: boolean
}

export interface SeedQuery {
  id: number
  query: string
  addedAt: string
  lastRunAt: string | null
}

export interface CreateSeedQueryInput {
  query: string
  addedAt?: string
  lastRunAt?: string | null
}

export type UpdateSeedQueryInput = Partial<Omit<SeedQuery, 'id'>>

export interface Settings {
  id: 1
  lwaClientId: string | null
  lwaClientSecret: string | null
  refreshToken: string | null
  marketplaceId: string
  region: string
  sweepIntervalMin: number
  ntfyTopic: string | null
  ntfyServer: string
  coldSweepCursor: number
  coldSweepDivisor: number
}

export type UpdateSettingsInput = Partial<Omit<Settings, 'id'>>

interface ProductRow extends Omit<Product, 'isArchived'> {
  isArchived: number
}

interface AlertRow extends Omit<Alert, 'isActive'> {
  isActive: number
}

interface AlertEventRow extends Omit<AlertEvent, 'delivered' | 'isRead'> {
  delivered: number
  isRead: number
}

function productFromRow(row: ProductRow): Product {
  return { ...row, isArchived: Boolean(row.isArchived) }
}

function alertFromRow(row: AlertRow): Alert {
  return { ...row, isActive: Boolean(row.isActive) }
}

function alertEventFromRow(row: AlertEventRow): AlertEvent {
  return { ...row, delivered: Boolean(row.delivered), isRead: Boolean(row.isRead) }
}

export function createProduct(db: DatabaseHandle, input: CreateProductInput): Product {
  // Archived products don't count against the cap — archiving frees capacity.
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM products WHERE isArchived = 0')
    .get() as { count: number }
  if (count >= MAX_TRACKED_PRODUCTS) {
    throw new Error(`Custos corpus is capped at ${MAX_TRACKED_PRODUCTS} products`)
  }
  const result = db.prepare(`
    INSERT INTO products (
      asin, title, brand, imageUrl, category, rankCategory, addedAt, source, isArchived
    ) VALUES (
      @asin, @title, @brand, @imageUrl, @category, @rankCategory, @addedAt, @source, @isArchived
    )
  `).run({
    title: null,
    brand: null,
    imageUrl: null,
    category: null,
    rankCategory: null,
    addedAt: new Date().toISOString(),
    source: 'manual',
    ...input,
    isArchived: input.isArchived ? 1 : 0,
  })
  return getProductById(db, Number(result.lastInsertRowid)) as Product
}

export function getProductById(db: DatabaseHandle, id: number): Product | undefined {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined
  return row && productFromRow(row)
}

export function getProductByAsin(db: DatabaseHandle, asin: string): Product | undefined {
  const row = db.prepare('SELECT * FROM products WHERE asin = ?').get(asin) as ProductRow | undefined
  return row && productFromRow(row)
}

export function listProducts(db: DatabaseHandle, nonArchived = true): Product[] {
  const sql = nonArchived
    ? 'SELECT * FROM products WHERE isArchived = 0 ORDER BY id'
    : 'SELECT * FROM products ORDER BY id'
  return (db.prepare(sql).all() as ProductRow[]).map(productFromRow)
}

export const listNonArchivedProducts = listProducts

export function archiveProduct(
  db: DatabaseHandle,
  id: number,
  isArchived = true,
): Product | undefined {
  db.prepare('UPDATE products SET isArchived = ? WHERE id = ?').run(isArchived ? 1 : 0, id)
  return getProductById(db, id)
}

export function deleteProduct(db: DatabaseHandle, id: number): boolean {
  return db.prepare('DELETE FROM products WHERE id = ?').run(id).changes > 0
}

export function updateProduct(
  db: DatabaseHandle,
  id: number,
  changes: Partial<Pick<Product, 'title' | 'isArchived'>>,
): Product | undefined {
  const keys = Object.keys(changes) as Array<keyof typeof changes>
  if (keys.length === 0) return getProductById(db, id)
  const values: Record<string, unknown> = { id }
  const assignments = keys.map((key) => {
    values[key] = key === 'isArchived' ? (changes[key] ? 1 : 0) : changes[key]
    return `${key} = @${key}`
  })
  db.prepare(`UPDATE products SET ${assignments.join(', ')} WHERE id = @id`).run(values)
  return getProductById(db, id)
}

export function updateProductCatalog(
  db: DatabaseHandle,
  asin: string,
  changes: ProductCatalogUpdate,
): Product | undefined {
  const keys = Object.keys(changes) as Array<keyof ProductCatalogUpdate>
  if (keys.length === 0) {
    return getProductByAsin(db, asin)
  }
  const values: Record<string, unknown> = { asin }
  const assignments = keys.map((key) => {
    values[key] = changes[key]
    return `${key} = @${key}`
  })
  db.prepare(`UPDATE products SET ${assignments.join(', ')} WHERE asin = @asin`).run(values)
  return getProductByAsin(db, asin)
}

/** Chunk size kept comfortably under SQLite's default 999 bound-parameter limit. */
const SQL_VARIABLE_CHUNK_SIZE = 500

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

/** Bulk, transactional tier assignment (tier-aware sweep scheduling). */
export function setProductTier(
  db: DatabaseHandle,
  asins: string[],
  tier: ProductTier,
): void {
  if (asins.length === 0) return
  db.transaction(() => {
    for (const batch of chunk(asins, SQL_VARIABLE_CHUNK_SIZE)) {
      const placeholders = batch.map(() => '?').join(', ')
      db.prepare(`UPDATE products SET tier = ? WHERE asin IN (${placeholders})`)
        .run(tier, ...batch)
    }
  })()
}

/** Tier counts among active (non-archived) products. */
export function countByTier(db: DatabaseHandle): { hot: number; cold: number } {
  const rows = db.prepare(`
    SELECT tier, COUNT(*) AS count FROM products WHERE isArchived = 0 GROUP BY tier
  `).all() as Array<{ tier: ProductTier; count: number }>
  const counts = { hot: 0, cold: 0 }
  for (const row of rows) counts[row.tier] = row.count
  return counts
}

export interface SweepAsinSelection {
  asins: string[]
  hotCount: number
  coldCount: number
  coldSliceCount: number
  nextCursor: number
}

export interface SelectSweepAsinsOptions {
  /** Number of cycles a full cold-tier pass is rotated across. <=1 sweeps all cold ASINs every cycle. */
  divisor?: number
  /** Which rotation slice (mod divisor) this cycle should cover. */
  cursor?: number
}

/**
 * All active hot ASINs, plus the cold-tier slice `index % divisor === cursor % divisor`
 * (stable ORDER BY asin ordering). Exhaustive across `divisor` consecutive cursors —
 * no cold ASIN is skipped or swept twice within one full rotation.
 */
export function selectSweepAsins(
  db: DatabaseHandle,
  options: SelectSweepAsinsOptions = {},
): SweepAsinSelection {
  const divisor = Math.max(1, Math.trunc(options.divisor ?? 1))
  const cursor = ((Math.trunc(options.cursor ?? 0) % divisor) + divisor) % divisor

  const hotAsins = (db.prepare(`
    SELECT asin FROM products WHERE isArchived = 0 AND tier = 'hot' ORDER BY asin
  `).all() as Array<{ asin: string }>).map((row) => row.asin)
  const coldAsins = (db.prepare(`
    SELECT asin FROM products WHERE isArchived = 0 AND tier = 'cold' ORDER BY asin
  `).all() as Array<{ asin: string }>).map((row) => row.asin)

  const coldSlice = coldAsins.filter((_, index) => index % divisor === cursor)

  return {
    asins: [...hotAsins, ...coldSlice],
    hotCount: hotAsins.length,
    coldCount: coldAsins.length,
    coldSliceCount: coldSlice.length,
    nextCursor: (cursor + 1) % divisor,
  }
}

export function bulkCreateProducts(
  db: DatabaseHandle,
  inputs: CreateProductInput[],
): Product[] {
  return db.transaction(() => {
    const created: Product[] = []
    for (const input of inputs) {
      if (!getProductByAsin(db, input.asin)) {
        created.push(createProduct(db, input))
      }
    }
    return created
  })()
}

export function insertSnapshot(db: DatabaseHandle, input: CreateSnapshotInput): Snapshot {
  const result = db.prepare(`
    INSERT INTO snapshots (
      asin, ts, buyBoxPrice, lowestNewPrice, lowestFbaPrice,
      offerCount, fbaOfferCount, salesRank, rankCategory
    ) VALUES (
      @asin, @ts, @buyBoxPrice, @lowestNewPrice, @lowestFbaPrice,
      @offerCount, @fbaOfferCount, @salesRank, @rankCategory
    )
  `).run(input)
  return db.prepare('SELECT * FROM snapshots WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as Snapshot
}

export function latestSnapshotForAsin(
  db: DatabaseHandle,
  asin: string,
): Snapshot | undefined {
  return db.prepare(`
    SELECT * FROM snapshots WHERE asin = ? ORDER BY ts DESC, id DESC LIMIT 1
  `).get(asin) as Snapshot | undefined
}

export function seriesForAsin(
  db: DatabaseHandle,
  asin: string,
  days: number,
  now: Date = new Date(),
): Snapshot[] {
  const cutoff = new Date(now.getTime() - Math.max(0, days) * 86_400_000).toISOString()
  return db.prepare(`
    SELECT * FROM snapshots WHERE asin = ? AND ts >= ? ORDER BY ts, id
  `).all(asin, cutoff) as Snapshot[]
}

/**
 * The two most recent REAL observations (miss rows skipped), latest first.
 * Callers doing in-stock/out-of-stock or value-change transitions rely on
 * this to never see a miss row on either side of the comparison.
 */
export function latestTwoForAsin(db: DatabaseHandle, asin: string): Snapshot[] {
  return db.prepare(`
    SELECT * FROM snapshots WHERE asin = ? AND ${OBSERVATION_SQL}
    ORDER BY ts DESC, id DESC LIMIT 2
  `).all(asin) as Snapshot[]
}

/**
 * Latest REAL observation for an ASIN (miss rows skipped) — distinct from
 * `latestSnapshotForAsin`, which returns the latest row of any kind
 * (including a miss row) for callers that need to know a sweep ran at all.
 */
export function latestObservationForAsin(
  db: DatabaseHandle,
  asin: string,
): Snapshot | undefined {
  return db.prepare(`
    SELECT * FROM snapshots WHERE asin = ? AND ${OBSERVATION_SQL}
    ORDER BY ts DESC, id DESC LIMIT 1
  `).get(asin) as Snapshot | undefined
}

export function maxPriceInWindow(
  db: DatabaseHandle,
  asin: string,
  hours: number,
  now: Date = new Date(),
): number | null {
  const cutoff = new Date(now.getTime() - Math.max(0, hours) * 3_600_000).toISOString()
  const row = db.prepare(`
    SELECT MAX(COALESCE(buyBoxPrice, lowestNewPrice)) AS maxPrice
    FROM snapshots
    WHERE asin = ? AND ts >= ? AND ts <= ?
  `).get(asin, cutoff, now.toISOString()) as { maxPrice: number | null }
  return row.maxPrice
}

export function createAlert(db: DatabaseHandle, input: CreateAlertInput): Alert {
  const result = db.prepare(`
    INSERT INTO alerts (
      asin, ruleType, threshold, windowHours, isActive, cooldownHours, lastFiredAt
    ) VALUES (
      @asin, @ruleType, @threshold, @windowHours, @isActive, @cooldownHours, @lastFiredAt
    )
  `).run({
    threshold: null,
    windowHours: 24,
    cooldownHours: 24,
    lastFiredAt: null,
    ...input,
    isActive: input.isActive === false ? 0 : 1,
  })
  return getAlertById(db, Number(result.lastInsertRowid)) as Alert
}

export function getAlertById(db: DatabaseHandle, id: number): Alert | undefined {
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined
  return row && alertFromRow(row)
}

export function listAlerts(db: DatabaseHandle): Alert[] {
  return (db.prepare('SELECT * FROM alerts ORDER BY id').all() as AlertRow[]).map(alertFromRow)
}

export function listActiveAlerts(db: DatabaseHandle): Alert[] {
  return (db.prepare(`
    SELECT * FROM alerts WHERE isActive = 1 ORDER BY id
  `).all() as AlertRow[]).map(alertFromRow)
}

export function updateAlert(
  db: DatabaseHandle,
  id: number,
  changes: UpdateAlertInput,
): Alert | undefined {
  const keys = Object.keys(changes) as Array<keyof UpdateAlertInput>
  if (keys.length === 0) {
    return getAlertById(db, id)
  }
  const values: Record<string, unknown> = { id }
  const assignments = keys.map((key) => {
    const value = changes[key]
    values[key] = key === 'isActive' ? (value ? 1 : 0) : value
    return `${key} = @${key}`
  })
  db.prepare(`UPDATE alerts SET ${assignments.join(', ')} WHERE id = @id`).run(values)
  return getAlertById(db, id)
}

export function deleteAlert(db: DatabaseHandle, id: number): boolean {
  return db.prepare('DELETE FROM alerts WHERE id = ?').run(id).changes > 0
}

export function insertAlertEvent(
  db: DatabaseHandle,
  input: CreateAlertEventInput,
): AlertEvent {
  const result = db.prepare(`
    INSERT INTO alert_events (
      alertId, asin, ts, message, delivered, deliveryError, isRead
    ) VALUES (
      @alertId, @asin, @ts, @message, @delivered, @deliveryError, @isRead
    )
  `).run({
    ...input,
    ts: input.ts ?? new Date().toISOString(),
    deliveryError: input.deliveryError ?? null,
    delivered: input.delivered ? 1 : 0,
    isRead: input.isRead ? 1 : 0,
  })
  const row = db.prepare('SELECT * FROM alert_events WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as AlertEventRow
  return alertEventFromRow(row)
}

export function listUnreadAlertEvents(db: DatabaseHandle): AlertEvent[] {
  const rows = db.prepare(`
    SELECT * FROM alert_events WHERE isRead = 0 ORDER BY ts DESC, id DESC
  `).all() as AlertEventRow[]
  return rows.map(alertEventFromRow)
}

export function listAlertEvents(db: DatabaseHandle, unreadOnly = false): AlertEvent[] {
  const sql = unreadOnly
    ? 'SELECT * FROM alert_events WHERE isRead = 0 ORDER BY ts DESC, id DESC'
    : 'SELECT * FROM alert_events ORDER BY ts DESC, id DESC'
  return (db.prepare(sql).all() as AlertEventRow[]).map(alertEventFromRow)
}

export function updateAlertEventDelivery(
  db: DatabaseHandle,
  id: number,
  delivered: boolean,
  deliveryError: string | null,
): AlertEvent | undefined {
  db.prepare(`
    UPDATE alert_events SET delivered = ?, deliveryError = ? WHERE id = ?
  `).run(delivered ? 1 : 0, deliveryError, id)
  const row = db.prepare('SELECT * FROM alert_events WHERE id = ?').get(id) as
    | AlertEventRow
    | undefined
  return row && alertEventFromRow(row)
}

export const listUnread = listUnreadAlertEvents

export function markAlertEventRead(db: DatabaseHandle, id: number): AlertEvent | undefined {
  db.prepare('UPDATE alert_events SET isRead = 1 WHERE id = ?').run(id)
  const row = db.prepare('SELECT * FROM alert_events WHERE id = ?').get(id) as
    | AlertEventRow
    | undefined
  return row && alertEventFromRow(row)
}

export const markRead = markAlertEventRead

export function createSeedQuery(
  db: DatabaseHandle,
  input: CreateSeedQueryInput,
): SeedQuery {
  const result = db.prepare(`
    INSERT INTO seed_queries (query, addedAt, lastRunAt)
    VALUES (@query, @addedAt, @lastRunAt)
  `).run({ addedAt: new Date().toISOString(), lastRunAt: null, ...input })
  return getSeedQueryById(db, Number(result.lastInsertRowid)) as SeedQuery
}

export function getSeedQueryById(db: DatabaseHandle, id: number): SeedQuery | undefined {
  return db.prepare('SELECT * FROM seed_queries WHERE id = ?').get(id) as SeedQuery | undefined
}

export function listSeedQueries(db: DatabaseHandle): SeedQuery[] {
  return db.prepare('SELECT * FROM seed_queries ORDER BY id').all() as SeedQuery[]
}

export function updateSeedQuery(
  db: DatabaseHandle,
  id: number,
  changes: UpdateSeedQueryInput,
): SeedQuery | undefined {
  const keys = Object.keys(changes) as Array<keyof UpdateSeedQueryInput>
  if (keys.length === 0) {
    return getSeedQueryById(db, id)
  }
  const values: Record<string, unknown> = { id }
  const assignments = keys.map((key) => {
    values[key] = changes[key]
    return `${key} = @${key}`
  })
  db.prepare(`UPDATE seed_queries SET ${assignments.join(', ')} WHERE id = @id`).run(values)
  return getSeedQueryById(db, id)
}

export function deleteSeedQuery(db: DatabaseHandle, id: number): boolean {
  return db.prepare('DELETE FROM seed_queries WHERE id = ?').run(id).changes > 0
}

export function getSettings(db: DatabaseHandle): Settings {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Settings | undefined
  if (!row) {
    throw new Error('Settings singleton row is missing')
  }
  return row
}

export function updateSettings(db: DatabaseHandle, changes: UpdateSettingsInput): Settings {
  const keys = Object.keys(changes) as Array<keyof UpdateSettingsInput>
  if (keys.length === 0) {
    return getSettings(db)
  }
  const values: Record<string, unknown> = { id: 1 }
  const assignments = keys.map((key) => {
    values[key] = changes[key]
    return `${key} = @${key}`
  })
  db.prepare(`UPDATE settings SET ${assignments.join(', ')} WHERE id = @id`).run(values)
  return getSettings(db)
}

// --- Platform registry product map (ASIN → canonical prd_ ULID) ---

export interface ProductMapping {
  id: number
  asin: string
  canonicalProductId: string
  registryVersion: number | null
  createdByUs: boolean
  resolvedAt: string
}

export interface UpsertProductMappingInput {
  asin: string
  canonicalProductId: string
  registryVersion?: number | null
  createdByUs?: boolean
  resolvedAt?: string
}

interface ProductMappingRow {
  id: number
  asin: string
  canonical_product_id: string
  registry_version: number | null
  created_by_us: number
  resolved_at: string
}

function productMappingFromRow(row: ProductMappingRow): ProductMapping {
  return {
    id: row.id,
    asin: row.asin,
    canonicalProductId: row.canonical_product_id,
    registryVersion: row.registry_version,
    createdByUs: Boolean(row.created_by_us),
    resolvedAt: row.resolved_at,
  }
}

export function upsertProductMapping(
  db: DatabaseHandle,
  input: UpsertProductMappingInput,
): ProductMapping {
  const resolvedAt = input.resolvedAt ?? new Date().toISOString()
  const createdByUs = input.createdByUs ? 1 : 0
  const registryVersion = input.registryVersion ?? null
  db.prepare(`
    INSERT INTO registry_product_map (
      asin, canonical_product_id, registry_version, created_by_us, resolved_at
    ) VALUES (
      @asin, @canonicalProductId, @registryVersion, @createdByUs, @resolvedAt
    )
    ON CONFLICT(asin) DO UPDATE SET
      canonical_product_id = excluded.canonical_product_id,
      registry_version = excluded.registry_version,
      created_by_us = excluded.created_by_us,
      resolved_at = excluded.resolved_at
  `).run({
    asin: input.asin,
    canonicalProductId: input.canonicalProductId,
    registryVersion,
    createdByUs,
    resolvedAt,
  })
  return getMappingByAsin(db, input.asin) as ProductMapping
}

export function getMappingByAsin(
  db: DatabaseHandle,
  asin: string,
): ProductMapping | undefined {
  const row = db.prepare(
    'SELECT * FROM registry_product_map WHERE asin = ?',
  ).get(asin) as ProductMappingRow | undefined
  return row && productMappingFromRow(row)
}

/** Resolve ASIN mapping by Hub canonical product id (prd_ ULID). */
export function getMappingByCanonicalId(
  db: DatabaseHandle,
  canonicalProductId: string,
): ProductMapping | undefined {
  const row = db.prepare(
    'SELECT * FROM registry_product_map WHERE canonical_product_id = ?',
  ).get(canonicalProductId) as ProductMappingRow | undefined
  return row && productMappingFromRow(row)
}

/** Active (non-archived) product ASINs with no registry_product_map row. */
export function listActiveAsinsMissingMapping(db: DatabaseHandle): string[] {
  const rows = db.prepare(`
    SELECT p.asin AS asin
    FROM products p
    LEFT JOIN registry_product_map m ON m.asin = p.asin
    WHERE p.isArchived = 0 AND m.asin IS NULL
    ORDER BY p.asin
  `).all() as Array<{ asin: string }>
  return rows.map((row) => row.asin)
}
