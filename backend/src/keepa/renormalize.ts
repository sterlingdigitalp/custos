// Re-normalize keepa_points from stored keepa_raw payloads (KEEPA-BACKFILL.md K6.0).
//
// One-time (and repeatable) pass that rebuilds keepa_points using the current
// normalizeKeepaProduct logic — no API tokens, no network access, raw
// payloads are re-normalizable forever (K1). Safe to run while a backfill is
// in progress: each ASIN is rewritten inside its own DELETE+INSERT
// transaction, the same per-ASIN commit pattern backfill.ts's commitAsin
// uses, so the two writers never observe a torn state for a given ASIN —
// either they touch disjoint ASINs, or they race to write the
// identical/idempotent result for the same one.

import { gunzipSync } from 'node:zlib'

import type { DatabaseHandle } from '../db/schema.js'
import { normalizeKeepaProduct } from './normalize.js'

export interface RenormalizeOptions {
  log?: (message: string) => void
}

export interface RenormalizeSummary {
  asins: number
  pointsBefore: number
  pointsAfter: number
}

interface KeepaRawRow {
  asin: string
  payload: Buffer
}

function countPoints(db: DatabaseHandle, asin: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM keepa_points WHERE asin = ?',
  ).get(asin) as { c: number }
  return row.c
}

/**
 * Rebuild keepa_points for every ASIN present in keepa_raw, using the
 * current normalize.ts rules. Idempotent — re-running produces identical
 * output for unchanged raw payloads.
 */
export function renormalizeAll(
  db: DatabaseHandle,
  options: RenormalizeOptions = {},
): RenormalizeSummary {
  const log = options.log ?? (() => {})

  const rows = db.prepare(`
    SELECT asin, payload FROM keepa_raw ORDER BY asin
  `).all() as KeepaRawRow[]

  const summary: RenormalizeSummary = { asins: 0, pointsBefore: 0, pointsAfter: 0 }

  if (rows.length === 0) {
    log('keepa-renormalize: no keepa_raw rows found')
    return summary
  }

  log(`keepa-renormalize: ${rows.length} ASIN(s) to re-normalize`)

  const insertPoint = db.prepare(`
    INSERT OR IGNORE INTO keepa_points (asin, metric, ts, value)
    VALUES (@asin, @metric, @ts, @value)
  `)
  const deletePoints = db.prepare('DELETE FROM keepa_points WHERE asin = ?')

  for (const row of rows) {
    const asin = row.asin

    let product: Record<string, unknown>
    try {
      const json = gunzipSync(row.payload).toString('utf8')
      product = JSON.parse(json) as Record<string, unknown>
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`keepa-renormalize: failed to decode payload for ${asin}: ${message}`)
      continue
    }

    const points = normalizeKeepaProduct({
      asin,
      csv: product.csv as Array<number[] | null> | null | undefined,
    })

    const before = countPoints(db, asin)

    db.transaction(() => {
      deletePoints.run(asin)
      for (const point of points) {
        insertPoint.run({
          asin: point.asin,
          metric: point.metric,
          ts: point.ts,
          value: point.value,
        })
      }
    })()

    const after = countPoints(db, asin)

    summary.asins += 1
    summary.pointsBefore += before
    summary.pointsAfter += after
    log(`keepa-renormalize: ${asin} points ${before} -> ${after}`)
  }

  log(
    `keepa-renormalize: finished asins=${summary.asins} ` +
    `pointsBefore=${summary.pointsBefore} pointsAfter=${summary.pointsAfter}`,
  )
  return summary
}
