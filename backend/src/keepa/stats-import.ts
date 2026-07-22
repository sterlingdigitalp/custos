// Track A: Product Viewer CSV → keepa_stats (KEEPA-BACKFILL.md K7).
// Flexible header-mapped columns; preview/apply; unknown ASINs skipped.

import { getProductByAsin } from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'

const ASIN_RE = /^[A-Z0-9]{10}$/

const METRIC_ALIASES: Record<string, string> = {
  amazon: 'amazon',
  new: 'new',
  new_fba: 'new_fba',
  fba: 'new_fba',
  newfba: 'new_fba',
  buybox: 'buybox',
  buy_box: 'buybox',
  bb: 'buybox',
  salesrank: 'salesrank',
  sales_rank: 'salesrank',
  rank: 'salesrank',
  offercount: 'offercount',
  offer_count: 'offercount',
  offers: 'offercount',
}

/** Money metrics store cents; rank/count stay as raw integers. */
const MONEY_METRICS = new Set(['amazon', 'new', 'new_fba', 'buybox'])

export interface KeepaStatsCell {
  metric: string
  window: string
  stat: 'min' | 'max' | 'avg'
  /** Raw parsed number from CSV (dollars for money, raw for rank/count). */
  raw: number
}

export interface KeepaStatsRow {
  asin: string
  cells: KeepaStatsCell[]
}

export interface KeepaStatsParseResult {
  rows: KeepaStatsRow[]
  skippedInvalid: number
  /** Headers that looked like stat columns but weren't recognized. */
  unrecognizedHeaders: string[]
}

export interface KeepaStatsPreview {
  mode: 'preview'
  rowCount: number
  knownAsinCount: number
  unknownAsinCount: number
  skippedInvalid: number
  statsRowsWouldWrite: number
  unknownAsins: string[]
  sample: Array<{ asin: string; metrics: string[] }>
  unrecognizedHeaders: string[]
}

export interface KeepaStatsApplySummary {
  mode: 'apply'
  upserted: number
  unknownAsinSkipped: number
  skippedInvalid: number
  rowsProcessed: number
}

function tokenizeCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  const finishRecord = () => {
    record.push(field)
    if (record.some((value) => value.trim() !== '')) records.push(record)
    record = []
    field = ''
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }

    if (character === '"' && field === '') {
      quoted = true
    } else if (character === ',') {
      record.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      finishRecord()
    } else {
      field += character
    }
  }

  if (field !== '' || record.length > 0) finishRecord()
  return records
}

function normalizedHeader(value: string, index: number): string {
  const withoutBom = index === 0 ? value.replace(/^\uFEFF/, '') : value
  return withoutBom.trim().toLowerCase().replace(/\s+/g, '_')
}

interface StatColumn {
  index: number
  metric: string
  window: string
  stat: 'min' | 'max' | 'avg'
}

/**
 * Parse header like buybox_90_min, buybox_90d_avg, salesrank_365_max,
 * amazon_all_min, new_fba_30_avg.
 */
function parseStatHeader(header: string): Omit<StatColumn, 'index'> | null {
  // metric(_part)*_window_stat — window is last token before min/max/avg
  const match = header.match(
    /^(.+)_([a-z0-9]+)_(min|max|avg)$/,
  )
  if (!match) return null

  const rawMetric = match[1]!
  const window = match[2]!
  const stat = match[3] as 'min' | 'max' | 'avg'

  const metricKey = rawMetric.replace(/-/g, '_')
  const metric = METRIC_ALIASES[metricKey]
  if (!metric) return null

  return { metric, window, stat }
}

export function parseKeepaStats(text: string): KeepaStatsParseResult {
  const records = tokenizeCsv(text)
  const header = records.shift()
  if (!header) {
    return { rows: [], skippedInvalid: 0, unrecognizedHeaders: [] }
  }

  const headers = header.map(normalizedHeader)
  let asinIndex = headers.findIndex((h) =>
    h === 'asin' || h === 'product_asin' || h === 'productasin',
  )
  if (asinIndex < 0) asinIndex = 0

  const statColumns: StatColumn[] = []
  const unrecognizedHeaders: string[] = []
  headers.forEach((name, index) => {
    if (index === asinIndex) return
    if (name === '' || name === 'title' || name === 'name' || name === 'product') return
    const parsed = parseStatHeader(name)
    if (parsed) {
      statColumns.push({ index, ...parsed })
    } else if (/_(min|max|avg)$/.test(name) || /_(90|30|365|180|7|all)/.test(name)) {
      unrecognizedHeaders.push(header[index] ?? name)
    }
  })

  const rows: KeepaStatsRow[] = []
  let skippedInvalid = 0
  const seen = new Set<string>()

  for (const values of records) {
    const asinRaw = (values[asinIndex] ?? '').trim().toUpperCase()
    if (!ASIN_RE.test(asinRaw)) {
      skippedInvalid += 1
      continue
    }
    if (seen.has(asinRaw)) continue
    seen.add(asinRaw)

    const cells: KeepaStatsCell[] = []
    for (const col of statColumns) {
      const rawText = (values[col.index] ?? '').trim()
      if (rawText === '' || rawText === '-' || rawText.toLowerCase() === 'n/a') continue
      const raw = Number(rawText.replace(/[$,]/g, ''))
      if (!Number.isFinite(raw)) continue
      cells.push({
        metric: col.metric,
        window: col.window,
        stat: col.stat,
        raw,
      })
    }
    rows.push({ asin: asinRaw, cells })
  }

  return { rows, skippedInvalid, unrecognizedHeaders }
}

function toStoredValue(metric: string, raw: number): number {
  if (MONEY_METRICS.has(metric)) {
    // Keepa viewer exports dollars; store integer cents.
    // If already looks like integer cents (>= 1000 and no fractional part from dollars
    // that are whole dollars), still treat as dollars: 79 → 7900, 79.95 → 7995.
    return Math.round(raw * 100)
  }
  return Math.round(raw)
}

function groupCells(
  cells: KeepaStatsCell[],
): Map<string, { metric: string; window: string; min?: number; max?: number; avg?: number }> {
  const groups = new Map<string, { metric: string; window: string; min?: number; max?: number; avg?: number }>()
  for (const cell of cells) {
    const key = `${cell.metric}\0${cell.window}`
    let group = groups.get(key)
    if (!group) {
      group = { metric: cell.metric, window: cell.window }
      groups.set(key, group)
    }
    const stored = toStoredValue(cell.metric, cell.raw)
    if (cell.stat === 'min') group.min = stored
    else if (cell.stat === 'max') group.max = stored
    else group.avg = stored
  }
  return groups
}

export function previewKeepaStats(db: DatabaseHandle, text: string): KeepaStatsPreview {
  const parsed = parseKeepaStats(text)
  const unknownAsins: string[] = []
  let knownAsinCount = 0
  let statsRowsWouldWrite = 0
  const sample: KeepaStatsPreview['sample'] = []

  for (const row of parsed.rows) {
    const known = getProductByAsin(db, row.asin) !== undefined
    if (!known) {
      unknownAsins.push(row.asin)
      continue
    }
    knownAsinCount += 1
    const groups = groupCells(row.cells)
    statsRowsWouldWrite += groups.size
    if (sample.length < 10) {
      sample.push({
        asin: row.asin,
        metrics: [...groups.values()].map((g) => `${g.metric}/${g.window}`),
      })
    }
  }

  return {
    mode: 'preview',
    rowCount: parsed.rows.length,
    knownAsinCount,
    unknownAsinCount: unknownAsins.length,
    skippedInvalid: parsed.skippedInvalid,
    statsRowsWouldWrite,
    unknownAsins: unknownAsins.slice(0, 50),
    sample,
    unrecognizedHeaders: parsed.unrecognizedHeaders,
  }
}

export function importKeepaStats(
  db: DatabaseHandle,
  text: string,
  options: { now?: () => Date } = {},
): KeepaStatsApplySummary {
  const parsed = parseKeepaStats(text)
  const now = options.now ?? (() => new Date())
  const importedAt = now().toISOString()

  return db.transaction(() => {
    let upserted = 0
    let unknownAsinSkipped = 0

    const upsert = db.prepare(`
      INSERT INTO keepa_stats (
        asin, window, metric, min_cents, max_cents, avg_cents, extra_json, imported_at
      ) VALUES (
        @asin, @window, @metric, @min_cents, @max_cents, @avg_cents, NULL, @imported_at
      )
      ON CONFLICT(asin, window, metric) DO UPDATE SET
        min_cents = excluded.min_cents,
        max_cents = excluded.max_cents,
        avg_cents = excluded.avg_cents,
        extra_json = excluded.extra_json,
        imported_at = excluded.imported_at
    `)

    for (const row of parsed.rows) {
      if (!getProductByAsin(db, row.asin)) {
        unknownAsinSkipped += 1
        continue
      }
      for (const group of groupCells(row.cells).values()) {
        upsert.run({
          asin: row.asin,
          window: group.window,
          metric: group.metric,
          min_cents: group.min ?? null,
          max_cents: group.max ?? null,
          avg_cents: group.avg ?? null,
          imported_at: importedAt,
        })
        upserted += 1
      }
    }

    return {
      mode: 'apply' as const,
      upserted,
      unknownAsinSkipped,
      skippedInvalid: parsed.skippedInvalid,
      rowsProcessed: parsed.rows.length,
    }
  })()
}
