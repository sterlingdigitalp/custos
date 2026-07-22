import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'

import { deliverPending, type Fetch } from '../alerts/deliver.js'
import { evaluateAlerts } from '../alerts/evaluate.js'
import { runSweep } from '../collector/sweep.js'
import {
  bulkCreateProducts,
  createAlert,
  createSeedQuery,
  deleteAlert,
  deleteProduct,
  deleteSeedQuery,
  getAlertById,
  getProductById,
  getSettings,
  listAlertEvents,
  listAlerts,
  listProducts,
  listSeedQueries,
  seriesForAsin,
  updateAlert,
  updateProduct,
  updateSeedQuery,
  updateSettings,
  upsertProductMapping,
  type AlertRuleType,
  type CreateAlertInput,
  type Settings,
} from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'
import { importSelleramp, parseSelleramp } from '../import/selleramp.js'
import { importKeepaStats, previewKeepaStats } from '../keepa/stats-import.js'
import { loadHubConfig } from '../platform/config.js'
import { buildHistoryContribution } from '../platform/contrib.js'
import { RegistryClient } from '../platform/registry.js'
import type { CustosApiClient } from '../spapi/client.js'
import type { SchedulerController, SchedulerStatus } from '../scheduler/loop.js'

/** Parse HISTORY_CONTRIB_TOKENS once at server build (D12). null = open (localhost debt). */
function parseContribTokens(raw: string | undefined): Set<string> | null {
  if (raw === undefined || raw.trim() === '') return null
  const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
  return tokens.length === 0 ? null : new Set(tokens)
}

type ClientDependency = CustosApiClient | (() => CustosApiClient | Promise<CustosApiClient>)

export interface ServerDependencies {
  client: ClientDependency
  scheduler?: Pick<SchedulerController, 'getStatus'>
  fetchImpl?: Fetch
  now?: () => Date
}

class ApiError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ApiError('Request body must be a JSON object')
  return body
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new ApiError(`Unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
  }
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(`${key} must be a non-empty string`)
  }
  return value.trim()
}

function finiteNumber(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(`${key} must be a finite number`)
  }
  return value
}

function integer(value: unknown, key: string): number {
  const parsed = typeof value === 'string' && value !== '' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new ApiError(`${key} must be an integer`)
  }
  return parsed
}

function positiveId(value: unknown): number {
  const id = integer(value, 'id')
  if (id < 1) throw new ApiError('id must be a positive integer')
  return id
}

function normalizedAsin(value: unknown, key = 'asin'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(`${key} must be a non-empty string`)
  }
  return value.trim().toUpperCase()
}

function asinList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((asin) => typeof asin === 'string' && asin.trim() !== '')) {
    throw new ApiError('asins must be an array of non-empty strings')
  }
  return [...new Set(value.map((asin) => normalizedAsin(asin)))]
}

function maskedSettings(settings: Settings): Settings {
  return {
    ...settings,
    lwaClientSecret: settings.lwaClientSecret === null ? null : '***set***',
    refreshToken: settings.refreshToken === null ? null : '***set***',
  }
}

async function resolveClient(dependency: ClientDependency): Promise<CustosApiClient> {
  return typeof dependency === 'function' ? dependency() : dependency
}

function unavailableSchedulerStatus(): SchedulerStatus {
  return {
    running: false,
    sweepRunning: false,
    lastSummary: null,
    lastError: null,
    nextRunAt: null,
  }
}

function productsWithLatest(db: DatabaseHandle): unknown[] {
  const rows = db.prepare(`
    SELECT p.*,
      s.id AS snapshotId, s.ts AS snapshotTs, s.buyBoxPrice, s.lowestNewPrice,
      s.lowestFbaPrice, s.offerCount, s.fbaOfferCount, s.salesRank,
      s.rankCategory AS snapshotRankCategory
    FROM products p
    LEFT JOIN snapshots s ON s.id = (
      SELECT s2.id FROM snapshots s2 WHERE s2.asin = p.asin
      ORDER BY s2.ts DESC, s2.id DESC LIMIT 1
    )
    ORDER BY p.id
  `).all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: row.id,
    asin: row.asin,
    title: row.title,
    brand: row.brand,
    imageUrl: row.imageUrl,
    category: row.category,
    rankCategory: row.rankCategory,
    addedAt: row.addedAt,
    source: row.source,
    isArchived: Boolean(row.isArchived),
    snapshotTs: row.snapshotTs,
    buyBoxPrice: row.buyBoxPrice,
    lowestNewPrice: row.lowestNewPrice,
    lowestFbaPrice: row.lowestFbaPrice,
    offerCount: row.offerCount,
    fbaOfferCount: row.fbaOfferCount,
    salesRank: row.salesRank,
    latestSnapshot: row.snapshotId === null ? null : {
      id: row.snapshotId,
      asin: row.asin,
      ts: row.snapshotTs,
      buyBoxPrice: row.buyBoxPrice,
      lowestNewPrice: row.lowestNewPrice,
      lowestFbaPrice: row.lowestFbaPrice,
      offerCount: row.offerCount,
      fbaOfferCount: row.fbaOfferCount,
      salesRank: row.salesRank,
      rankCategory: row.snapshotRankCategory,
    },
  }))
}

const ALERT_RULES: AlertRuleType[] = [
  'price_below', 'drop_percent', 'back_in_stock', 'rank_below', 'buybox_change',
]

function alertChanges(body: Record<string, unknown>, creating: boolean): CreateAlertInput {
  const changes: CreateAlertInput = {
    asin: creating ? normalizedAsin(body.asin) : '',
    ruleType: 'price_below',
  }
  if (creating || 'ruleType' in body) {
    if (!ALERT_RULES.includes(body.ruleType as AlertRuleType)) {
      throw new ApiError('ruleType must be a supported alert rule')
    }
    changes.ruleType = body.ruleType as AlertRuleType
  }
  if ('threshold' in body) {
    changes.threshold = body.threshold === null ? null : finiteNumber(body.threshold, 'threshold')
  }
  if ('windowHours' in body) {
    changes.windowHours = finiteNumber(body.windowHours, 'windowHours')
    if (changes.windowHours < 0) throw new ApiError('windowHours must be zero or greater')
  }
  if ('cooldownHours' in body) {
    changes.cooldownHours = finiteNumber(body.cooldownHours, 'cooldownHours')
    if (changes.cooldownHours < 0) throw new ApiError('cooldownHours must be zero or greater')
  }
  if ('isActive' in body) {
    if (typeof body.isActive !== 'boolean') throw new ApiError('isActive must be a boolean')
    changes.isActive = body.isActive
  }
  const thresholdRule = changes.ruleType === 'price_below' ||
    changes.ruleType === 'drop_percent' || changes.ruleType === 'rank_below'
  if (creating && thresholdRule && (changes.threshold === undefined || changes.threshold === null)) {
    throw new ApiError(`threshold is required for ${changes.ruleType}`)
  }
  return changes
}

function finderResults(db: DatabaseHandle, body: Record<string, unknown>, now: Date): unknown[] {
  rejectUnknownFields(body, [
    'priceMin', 'priceMax', 'minPrice', 'maxPrice',
    'rankMin', 'rankMax', 'minRank', 'maxRank',
    'offerCountMax', 'maxOfferCount', 'priceDropPercent', 'rankImprovedPercent',
    'windowDays', 'priceWindowDays', 'rankWindowDays', 'category', 'sortBy', 'sortDir',
  ])
  const readNumber = (keys: string[]): number | null => {
    const key = keys.find((candidate) => candidate in body)
    return key ? finiteNumber(body[key], key) : null
  }
  const priceMin = readNumber(['priceMin', 'minPrice'])
  const priceMax = readNumber(['priceMax', 'maxPrice'])
  const rankMin = readNumber(['rankMin', 'minRank'])
  const rankMax = readNumber(['rankMax', 'maxRank'])
  const offerCountMax = readNumber(['offerCountMax', 'maxOfferCount'])
  const priceDropPercent = readNumber(['priceDropPercent'])
  const rankImprovedPercent = readNumber(['rankImprovedPercent'])
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    throw new ApiError('price minimum must be less than or equal to price maximum')
  }
  if (rankMin !== null && rankMax !== null && rankMin > rankMax) {
    throw new ApiError('rank minimum must be less than or equal to rank maximum')
  }
  const sharedWindow = readNumber(['windowDays']) ?? 30
  const priceWindowDays = readNumber(['priceWindowDays']) ?? sharedWindow
  const rankWindowDays = readNumber(['rankWindowDays']) ?? sharedWindow
  if (priceWindowDays < 0 || rankWindowDays < 0) throw new ApiError('window days must be zero or greater')
  const category = 'category' in body ? requiredString(body, 'category').toLocaleLowerCase() : null
  const sortBy = body.sortBy ?? 'asin'
  const sortColumns: Record<string, string> = {
    asin: 'asin', price: 'currentPrice', rank: 'salesRank', offers: 'offerCount',
    priceDropPercent: 'priceDropPercent', rankImprovedPercent: 'rankImprovedPercent',
  }
  if (typeof sortBy !== 'string' || !sortColumns[sortBy]) throw new ApiError('sortBy is not supported')
  const sortDir = body.sortDir ?? 'asc'
  if (sortDir !== 'asc' && sortDir !== 'desc') throw new ApiError("sortDir must be 'asc' or 'desc'")

  const conditions = ['p.isArchived = 0']
  const params: Record<string, unknown> = {
    priceCutoff: new Date(now.getTime() - priceWindowDays * 86_400_000).toISOString(),
    rankCutoff: new Date(now.getTime() - rankWindowDays * 86_400_000).toISOString(),
  }
  const add = (value: number | null, name: string, sql: string): void => {
    if (value !== null) {
      params[name] = value
      conditions.push(sql)
    }
  }
  add(priceMin, 'priceMin', 'currentPrice >= @priceMin')
  add(priceMax, 'priceMax', 'currentPrice <= @priceMax')
  add(rankMin, 'rankMin', 'salesRank >= @rankMin')
  add(rankMax, 'rankMax', 'salesRank <= @rankMax')
  add(offerCountMax, 'offerCountMax', 'offerCount <= @offerCountMax')
  add(priceDropPercent, 'priceDropPercent', 'priceDropPercent >= @priceDropPercent')
  add(rankImprovedPercent, 'rankImprovedPercent', 'rankImprovedPercent >= @rankImprovedPercent')
  if (category !== null) {
    params.category = `%${category}%`
    conditions.push('LOWER(COALESCE(p.category, \'\')) LIKE @category')
  }

  const rows = db.prepare(`
    WITH latest AS (
      SELECT s.* FROM snapshots s
      WHERE s.id = (
        SELECT s2.id FROM snapshots s2 WHERE s2.asin = s.asin
        ORDER BY s2.ts DESC, s2.id DESC LIMIT 1
      )
    ), metrics AS (
      SELECT l.*,
        COALESCE(l.buyBoxPrice, l.lowestNewPrice) AS currentPrice,
        (SELECT MAX(COALESCE(w.buyBoxPrice, w.lowestNewPrice)) FROM snapshots w
          WHERE w.asin = l.asin AND w.ts >= @priceCutoff) AS windowMaxPrice,
        (SELECT MAX(w.salesRank) FROM snapshots w
          WHERE w.asin = l.asin AND w.ts >= @rankCutoff) AS windowMaxRank
      FROM latest l
    ), calculated AS (
      SELECT m.*,
        CASE WHEN windowMaxPrice > 0 AND currentPrice IS NOT NULL
          THEN (windowMaxPrice - currentPrice) * 100.0 / windowMaxPrice END AS priceDropPercent,
        CASE WHEN windowMaxRank > 0 AND salesRank IS NOT NULL
          THEN (windowMaxRank - salesRank) * 100.0 / windowMaxRank END AS rankImprovedPercent
      FROM metrics m
    )
    SELECT p.*, c.id AS snapshotId, c.ts, c.buyBoxPrice, c.lowestNewPrice,
      c.lowestFbaPrice, c.offerCount, c.fbaOfferCount, c.salesRank,
      c.rankCategory AS snapshotRankCategory, c.currentPrice, c.windowMaxPrice,
      c.windowMaxRank, c.priceDropPercent, c.rankImprovedPercent
    FROM calculated c JOIN products p ON p.asin = c.asin
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${sortColumns[sortBy]} ${sortDir.toUpperCase()}, p.asin ASC
  `).all(params) as Array<Record<string, unknown>>
  return rows.map((row) => ({ ...row, isArchived: Boolean(row.isArchived) }))
}

export function buildServer(db: DatabaseHandle, deps: ServerDependencies): FastifyInstance {
  const server = Fastify({ logger: false })
  // D12: optional bearer allowlist. Read once; unset/empty → open (localhost debt).
  const contribTokens = parseContribTokens(process.env.HISTORY_CONTRIB_TOKENS)

  server.addContentTypeParser('text/csv', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body)
  })

  // Extra origins the SPA may be served from (Vite module scripts are
  // crossorigin, so the app's own assets arrive WITH an Origin header —
  // e.g. http://platform:4400 over the tailnet). Comma-separated exact origins.
  const extraOrigins = new Set(
    (process.env.CUSTOS_ALLOWED_ORIGINS ?? '')
      .split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  )
  void server.register(cors, {
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    origin(origin, callback) {
      const allowed = origin === undefined || /^chrome-extension:\/\//.test(origin) ||
        /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin) ||
        extraOrigins.has(origin)
      callback(allowed ? null : new Error('Origin not allowed'), allowed)
    },
  })

  server.setErrorHandler((error: unknown, _request, reply) => {
    const httpStatus = (error as { statusCode?: unknown }).statusCode
    const sqliteConstraint = (error as { code?: unknown }).code
    const statusCode = error instanceof ApiError
      ? error.statusCode
      : typeof httpStatus === 'number' && httpStatus >= 400
        ? httpStatus
        : typeof sqliteConstraint === 'string' && sqliteConstraint.startsWith('SQLITE_CONSTRAINT')
          ? 400
          : 500
    const message = error instanceof Error ? error.message : 'Internal server error'
    void reply.status(statusCode).send({ error: message })
  })

  server.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({ error: `Route ${request.method} ${request.url} not found` })
  })

  // History contribution endpoints (P3). HTTP 200 for ALL contribution outcomes
  // (absent/unavailable are valid payloads — non-200 is transport failure for andrew).
  const requireContribAuth = async (
    request: { headers: { authorization?: string } },
    reply: {
      sent: boolean
      status: (code: number) => { send: (body: unknown) => unknown }
    },
  ): Promise<unknown> => {
    if (!contribTokens) return
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'unauthorized' })
    }
    const token = header.slice('Bearer '.length)
    if (!contribTokens.has(token)) {
      return reply.status(401).send({ error: 'unauthorized' })
    }
  }

  server.get<{ Params: { productId: string } }>(
    '/contrib/products/:productId',
    { preHandler: requireContribAuth },
    async (request) => {
      const now = deps.now?.() ?? new Date()
      const history = buildHistoryContribution(db, { productId: request.params.productId }, { now })
      return { history }
    },
  )

  server.get<{ Params: { asin: string } }>(
    '/contrib/asins/:asin',
    { preHandler: requireContribAuth },
    async (request) => {
      const now = deps.now?.() ?? new Date()
      const history = buildHistoryContribution(
        db,
        { asin: request.params.asin },
        { now },
      )
      return { history }
    },
  )

  server.get('/api/products', async () => productsWithLatest(db))

  server.post('/api/import/selleramp/preview', { bodyLimit: 10 * 1024 * 1024 }, async (request) => {
    if (typeof request.body !== 'string') throw new ApiError('Request body must be CSV text')
    const parsed = parseSelleramp(request.body)
    const tracked = new Set(listProducts(db, false).map((product) => product.asin))
    const newRows = parsed.rows.filter((row) => !tracked.has(row.asin))
    return {
      newCount: newRows.length,
      alreadyPresent: parsed.rows.length - newRows.length,
      skippedInvalid: parsed.skipped,
      sampleNew: newRows.slice(0, 10).map(({ asin, name }) => ({ asin, name })),
    }
  })

  server.post('/api/import/selleramp', { bodyLimit: 10 * 1024 * 1024 }, async (request) => {
    if (typeof request.body !== 'string') throw new ApiError('Request body must be CSV text')
    return importSelleramp(db, request.body)
  })

  // Track A Keepa Product Viewer stats (KEEPA-BACKFILL.md K7).
  server.post(
    '/api/import/keepa-stats',
    { bodyLimit: 20 * 1024 * 1024 },
    async (request) => {
      if (typeof request.body !== 'string') throw new ApiError('Request body must be CSV text')
      const modeRaw = (request.query as { mode?: unknown } | undefined)?.mode
      const mode = typeof modeRaw === 'string' ? modeRaw.toLowerCase() : 'preview'
      if (mode !== 'preview' && mode !== 'apply') {
        throw new ApiError("mode must be 'preview' or 'apply'")
      }
      if (mode === 'preview') return previewKeepaStats(db, request.body)
      return importKeepaStats(db, request.body, { now: deps.now })
    },
  )

  server.post('/api/products', async (request, reply) => {
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, ['asin', 'asins', 'source'])
    if (('asin' in body) === ('asins' in body)) throw new ApiError('Provide exactly one of asin or asins')
    const asins = 'asin' in body ? [normalizedAsin(body.asin)] : asinList(body.asins)
    if (asins.length === 0) throw new ApiError('asins must contain at least one ASIN')
    const source = body.source ?? 'manual'
    if (!['manual', 'import', 'seed', 'extension', 'aurora', 'selleramp'].includes(String(source))) {
      throw new ApiError('source must be a supported product source')
    }
    const products = bulkCreateProducts(db, asins.map((asin) => ({
      asin,
      source: source as 'manual' | 'import' | 'seed' | 'extension' | 'aurora' | 'selleramp',
    })))
    // Resolve-on-add (P1): fire-and-forget registry mapping when Hub is
    // configured. Must never fail or delay the HTTP response (D3/D6).
    if (products.length > 0) {
      try {
        const hubConfig = loadHubConfig()
        if (hubConfig) {
          const client = new RegistryClient(hubConfig)
          void Promise.all(
            products.map(async (product) => {
              const result = await client.resolveProduct({
                asin: product.asin,
                title: product.title,
              })
              if (!result.conflict) {
                upsertProductMapping(db, {
                  asin: product.asin,
                  canonicalProductId: result.productId,
                  registryVersion: result.registryVersion,
                  createdByUs: result.created,
                })
              }
            }),
          ).catch((err) => {
            console.error(
              '[platform] resolve-on-add failed:',
              err instanceof Error ? err.message : err,
            )
          })
        }
      } catch (err) {
        console.error(
          '[platform] resolve-on-add skipped (config error):',
          err instanceof Error ? err.message : err,
        )
      }
    }
    void reply.status(201)
    return 'asin' in body
      ? (products[0] ?? listProducts(db, false).find((product) => product.asin === asins[0]))
      : { added: products.length, skipped: asins.length - products.length, products }
  })

  server.patch('/api/products/:id', async (request) => {
    const id = positiveId((request.params as Record<string, unknown>).id)
    if (!getProductById(db, id)) throw new ApiError(`Product ${id} not found`, 404)
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, ['title', 'isArchived'])
    const changes: Parameters<typeof updateProduct>[2] = {}
    if ('title' in body) {
      if (body.title !== null && typeof body.title !== 'string') {
        throw new ApiError('title must be a string or null')
      }
      changes.title = body.title
    }
    if ('isArchived' in body) {
      if (typeof body.isArchived !== 'boolean') throw new ApiError('isArchived must be a boolean')
      changes.isArchived = body.isArchived
    }
    return updateProduct(db, id, changes)
  })

  server.delete('/api/products/:id', async (request, reply) => {
    const id = positiveId((request.params as Record<string, unknown>).id)
    const product = getProductById(db, id)
    if (!product) throw new ApiError(`Product ${id} not found`, 404)
    const snapshots = db.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE asin = ?')
      .get(product.asin) as { count: number }
    if (snapshots.count > 0) {
      throw new ApiError('Product has snapshot history; archive it instead', 409)
    }
    deleteProduct(db, id)
    void reply.status(204).send()
  })

  server.get('/api/products/:asin/history', async (request) => {
    const asin = normalizedAsin((request.params as Record<string, unknown>).asin)
    const query = request.query as Record<string, unknown>
    rejectUnknownFields(query, ['days'])
    const days = query.days === undefined ? 90 : finiteNumber(
      typeof query.days === 'string' ? Number(query.days) : query.days,
      'days',
    )
    if (days < 0) throw new ApiError('days must be zero or greater')
    return seriesForAsin(db, asin, days, deps.now?.() ?? new Date())
  })

  server.get('/api/alerts', async () => listAlerts(db))

  server.post('/api/alerts', async (request, reply) => {
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, ['asin', 'ruleType', 'threshold', 'windowHours', 'isActive', 'cooldownHours'])
    const alert = createAlert(db, alertChanges(body, true))
    void reply.status(201)
    return alert
  })

  server.patch('/api/alerts/:id', async (request) => {
    const id = positiveId((request.params as Record<string, unknown>).id)
    const existing = getAlertById(db, id)
    if (!existing) throw new ApiError(`Alert ${id} not found`, 404)
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, ['asin', 'ruleType', 'threshold', 'windowHours', 'isActive', 'cooldownHours'])
    const parsed = alertChanges({ ...body, asin: body.asin ?? existing.asin }, false)
    const changes: Parameters<typeof updateAlert>[2] = {}
    for (const key of ['ruleType', 'threshold', 'windowHours', 'isActive', 'cooldownHours'] as const) {
      if (key in body) Object.assign(changes, { [key]: parsed[key] })
    }
    if ('asin' in body) changes.asin = normalizedAsin(body.asin)
    return updateAlert(db, id, changes)
  })

  server.delete('/api/alerts/:id', async (request, reply) => {
    const id = positiveId((request.params as Record<string, unknown>).id)
    if (!deleteAlert(db, id)) throw new ApiError(`Alert ${id} not found`, 404)
    void reply.status(204).send()
  })

  server.get('/api/alert-events', async (request) => {
    const query = request.query as Record<string, unknown>
    rejectUnknownFields(query, ['unread'])
    const unread = query.unread === '1' || query.unread === 1 || query.unread === true
    return listAlertEvents(db, unread)
  })

  server.post('/api/alert-events/mark-read', async (request) => {
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, ['ids'])
    if (!Array.isArray(body.ids) || !body.ids.every((id) => Number.isInteger(id) && Number(id) > 0)) {
      throw new ApiError('ids must be an array of positive integers')
    }
    const ids = [...new Set(body.ids as number[])]
    const mark = db.prepare('UPDATE alert_events SET isRead = 1 WHERE id = ?')
    const marked = db.transaction(() => ids.reduce((count, id) => count + mark.run(id).changes, 0))()
    return { marked }
  })

  server.post('/api/finder', async (request) => {
    return finderResults(db, bodyRecord(request.body), deps.now?.() ?? new Date())
  })

  server.post('/api/seed/search', async (request) => {
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, ['query', 'pageToken'])
    const query = requiredString(body, 'query')
    if ('pageToken' in body && typeof body.pageToken !== 'string') {
      throw new ApiError('pageToken must be a string')
    }
    const result = await (await resolveClient(deps.client)).searchByKeywords(
      query,
      typeof body.pageToken === 'string' ? body.pageToken : undefined,
    )
    const tracked = new Set(listProducts(db, false).map((product) => product.asin))
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, isTracked: tracked.has(item.asin) })),
    }
  })

  server.post('/api/seed/add', async (request, reply) => {
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, ['asins'])
    const asins = asinList(body.asins)
    if (asins.length === 0) throw new ApiError('asins must contain at least one ASIN')
    const products = bulkCreateProducts(db, asins.map((asin) => ({ asin, source: 'seed' })))
    void reply.status(201)
    return { added: products.length, skipped: asins.length - products.length, products }
  })

  server.get('/api/seed-queries', async () => listSeedQueries(db))

  server.post('/api/seed-queries', async (request, reply) => {
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, ['query'])
    const seed = createSeedQuery(db, { query: requiredString(body, 'query') })
    void reply.status(201)
    return seed
  })

  server.patch('/api/seed-queries/:id', async (request) => {
    const id = positiveId((request.params as Record<string, unknown>).id)
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, ['query', 'lastRunAt'])
    const changes: Parameters<typeof updateSeedQuery>[2] = {}
    if ('query' in body) changes.query = requiredString(body, 'query')
    if ('lastRunAt' in body) {
      if (body.lastRunAt !== null && (
        typeof body.lastRunAt !== 'string' || !Number.isFinite(Date.parse(body.lastRunAt))
      )) throw new ApiError('lastRunAt must be null or an ISO date string')
      changes.lastRunAt = body.lastRunAt
    }
    const seed = updateSeedQuery(db, id, changes)
    if (!seed) throw new ApiError(`Seed query ${id} not found`, 404)
    return seed
  })

  server.delete('/api/seed-queries/:id', async (request, reply) => {
    const id = positiveId((request.params as Record<string, unknown>).id)
    if (!deleteSeedQuery(db, id)) throw new ApiError(`Seed query ${id} not found`, 404)
    void reply.status(204).send()
  })

  server.get('/api/settings', async () => maskedSettings(getSettings(db)))

  server.patch('/api/settings', async (request) => {
    const body = bodyRecord(request.body)
    rejectUnknownFields(body, [
      'lwaClientId', 'lwaClientSecret', 'refreshToken', 'marketplaceId', 'region',
      'sweepIntervalMin', 'ntfyTopic', 'ntfyServer',
    ])
    const changes: Parameters<typeof updateSettings>[1] = {}
    if ('sweepIntervalMin' in body) {
      const interval = integer(body.sweepIntervalMin, 'sweepIntervalMin')
      if (interval < 15) throw new ApiError('sweepIntervalMin must be at least 15')
      changes.sweepIntervalMin = interval
    }
    for (const key of ['marketplaceId', 'region', 'ntfyServer'] as const) {
      if (key in body) changes[key] = requiredString(body, key)
    }
    for (const key of ['lwaClientId', 'lwaClientSecret', 'refreshToken', 'ntfyTopic'] as const) {
      if (key in body) {
        const value = body[key]
        if (value !== null && typeof value !== 'string') {
          throw new ApiError(`${key} must be a string or null`)
        }
        if (value !== '***set***') changes[key] = value
      }
    }
    return maskedSettings(updateSettings(db, changes))
  })

  server.post('/api/settings/test-notification', async () => {
    const settings = getSettings(db)
    if (!settings.ntfyTopic || settings.ntfyTopic.trim() === '') {
      throw new ApiError('ntfyTopic must be configured before testing notifications')
    }
    try {
      const response = await (deps.fetchImpl ?? globalThis.fetch)(
        `${settings.ntfyServer.replace(/\/+$/, '')}/${encodeURIComponent(settings.ntfyTopic)}`,
        { method: 'POST', headers: { Title: 'Custos' }, body: 'Custos test notification' },
      )
      if (!response.ok) throw new Error(`ntfy test failed (${response.status})`)
      return { ok: true }
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : String(error), 502)
    }
  })

  server.get('/api/status', async () => {
    const client = await resolveClient(deps.client)
    const settings = getSettings(db)
    return {
      scheduler: deps.scheduler?.getStatus() ?? unavailableSchedulerStatus(),
      client: await client.ping(),
      clientMode: settings.lwaClientId && settings.lwaClientSecret && settings.refreshToken
        ? 'live'
        : 'mock',
      // Actively swept products only — archived rows aren't part of the
      // working corpus and shouldn't inflate the status panel.
      corpusSize: listProducts(db).length,
    }
  })

  server.post('/api/sweep/run', async () => {
    const now = deps.now?.() ?? new Date()
    const sweep = await runSweep(db, await resolveClient(deps.client), now)
    const alertsFired = evaluateAlerts(db, now)
    await deliverPending(db, getSettings(db), deps.fetchImpl)
    return {
      ...sweep,
      fetched: sweep.asins - sweep.bothMissed,
      failed: sweep.bothMissed,
      alertsFired,
    }
  })

  return server
}
