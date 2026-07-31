// Filters candidate ASINs by real Amazon sales evidence
// (`monthlySoldHistory` on the stored keepa_raw payload).
//
// Operator decision 2026-07-30: candidates with NO monthlySoldHistory at
// all are excluded (failNoData), not given the benefit of the doubt.

import { gunzipSync } from 'node:zlib'

import type { DatabaseHandle } from '../db/schema.js'

const DEFAULT_SINCE_ISO = '2024-01-01T00:00:00.000Z'

/** Keepa epoch-minutes <-> ISO offset (see normalize.ts keepaMinutesToIso). */
const KEEPA_EPOCH_OFFSET_MINUTES = 21_564_000

/** Inverse of normalize.ts's keepaMinutesToIso. */
function isoToKeepaMinutes(iso: string): number {
  const unixMs = Date.parse(iso)
  return Math.floor(unixMs / 60_000) - KEEPA_EPOCH_OFFSET_MINUTES
}

export interface QualifyBySalesOptions {
  /** ISO timestamp; only sales at-or-after this count. Default 2024-01-01. */
  sinceIso?: string
  log?: (message: string) => void
}

export interface QualifyBySalesResult {
  pass: string[]
  failNoSales: string[]
  failNoData: string[]
  notHarvested: string[]
  /** Peak in-window monthly units, for passing ASINs only. */
  peakUnits: Record<string, number>
}

interface KeepaRawRow {
  payload: Buffer
}

/**
 * Qualify candidate ASINs by whether Keepa's monthlySoldHistory shows any
 * real unit sales at-or-after `sinceIso`.
 */
export function qualifyBySales(
  db: DatabaseHandle,
  asins: string[],
  options: QualifyBySalesOptions = {},
): QualifyBySalesResult {
  const log = options.log ?? (() => {})
  const sinceIso = options.sinceIso ?? DEFAULT_SINCE_ISO
  const sinceKeepaMinutes = isoToKeepaMinutes(sinceIso)

  const result: QualifyBySalesResult = {
    pass: [],
    failNoSales: [],
    failNoData: [],
    notHarvested: [],
    peakUnits: {},
  }

  const dedupedAsins = Array.from(new Set(asins.map((asin) => asin.trim().toUpperCase())))
  const selectRaw = db.prepare('SELECT payload FROM keepa_raw WHERE asin = ?')

  for (const asin of dedupedAsins) {
    const row = selectRaw.get(asin) as KeepaRawRow | undefined
    if (!row) {
      result.notHarvested.push(asin)
      continue
    }

    let product: Record<string, unknown>
    try {
      product = JSON.parse(gunzipSync(row.payload).toString('utf8')) as Record<string, unknown>
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`keepa-qualify: failed to decode payload for ${asin}: ${message}`)
      result.failNoData.push(asin)
      continue
    }

    const history = product.monthlySoldHistory
    if (!Array.isArray(history) || history.length === 0) {
      result.failNoData.push(asin)
      continue
    }

    let passed = false
    let peak = 0
    for (let i = 0; i + 1 < history.length; i += 2) {
      const keepaMinutes = history[i]
      const units = history[i + 1]
      if (typeof keepaMinutes !== 'number' || typeof units !== 'number') continue
      if (keepaMinutes === -1 || units === -1) continue
      if (keepaMinutes >= sinceKeepaMinutes && units > 0) {
        passed = true
        if (units > peak) peak = units
      }
    }

    if (passed) {
      result.pass.push(asin)
      result.peakUnits[asin] = peak
    } else {
      result.failNoSales.push(asin)
    }
  }

  log(
    `keepa-qualify: pass=${result.pass.length} failNoSales=${result.failNoSales.length} ` +
    `failNoData=${result.failNoData.length} notHarvested=${result.notHarvested.length}`,
  )

  return result
}
