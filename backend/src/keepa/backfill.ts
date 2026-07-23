// Checkpointed Keepa history backfill (KEEPA-BACKFILL.md K4).
// Per-ASIN transactions; re-run skips done/not_found. Kill-safe.

import { gzipSync } from 'node:zlib'

import { listProducts } from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'
import {
  KeepaFatalRequestError,
  KeepaTokensExhaustedError,
  type KeepaClient,
} from './client.js'
import { normalizeKeepaProduct } from './normalize.js'

export interface KeepaBackfillOptions {
  priorityAsins?: string[]
  /** ASINs per Keepa request (max 100). Default 100. */
  batchSize?: number
  /** Stop after N ASINs attempted (smoke). */
  limit?: number
  log?: (message: string) => void
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export interface KeepaBackfillSummary {
  attempted: number
  done: number
  notFound: number
  failed: number
  tokensSpent: number
}

const TERMINAL = new Set(['done', 'not_found'])

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeAsin(asin: string): string {
  return asin.trim().toUpperCase()
}

/**
 * Build work list: priority ASINs first (in order), then active products
 * not yet done/not_found in keepa_checkpoint.
 */
export function buildKeepaWorkList(
  db: DatabaseHandle,
  priorityAsins: string[] = [],
): string[] {
  const skip = new Set(
    (db.prepare(`
      SELECT asin FROM keepa_checkpoint
      WHERE status IN ('done', 'not_found')
    `).all() as Array<{ asin: string }>).map((row) => row.asin),
  )

  const ordered: string[] = []
  const seen = new Set<string>()

  for (const raw of priorityAsins) {
    const asin = normalizeAsin(raw)
    if (!asin || seen.has(asin) || skip.has(asin)) continue
    seen.add(asin)
    ordered.push(asin)
  }

  for (const product of listProducts(db, true)) {
    const asin = normalizeAsin(product.asin)
    if (seen.has(asin) || skip.has(asin)) continue
    seen.add(asin)
    ordered.push(asin)
  }

  return ordered
}

export async function runKeepaBackfill(
  db: DatabaseHandle,
  client: KeepaClient,
  options: KeepaBackfillOptions = {},
): Promise<KeepaBackfillSummary> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 100)
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? defaultSleep
  const limit = options.limit

  let work = buildKeepaWorkList(db, options.priorityAsins ?? [])
  if (typeof limit === 'number' && limit >= 0) {
    work = work.slice(0, limit)
  }

  const summary: KeepaBackfillSummary = {
    attempted: 0,
    done: 0,
    notFound: 0,
    failed: 0,
    tokensSpent: 0,
  }

  if (work.length === 0) {
    log('keepa-backfill: nothing to do')
    return summary
  }

  log(`keepa-backfill: ${work.length} ASIN(s) queued (batchSize=${batchSize})`)

  // Running average tokens per ASIN (from actual tokensConsumed). Min 1.
  let tokensObserved = 0
  let asinsObserved = 0
  const avgTokensPerAsin = (): number =>
    asinsObserved > 0 ? Math.max(1, tokensObserved / asinsObserved) : 1

  for (let offset = 0; offset < work.length; offset += batchSize) {
    const batch = work.slice(offset, offset + batchSize)
    summary.attempted += batch.length

    let response
    try {
      response = await client.getProducts(batch)
    } catch (err) {
      if (err instanceof KeepaTokensExhaustedError) {
        const waitMs = Math.max(err.refillIn, 0) + 5_000
        log(`keepa-backfill: tokens exhausted; sleeping ${Math.ceil(waitMs / 1000)}s`)
        await sleep(waitMs)
        // Retry this batch once after sleep by rewinding offset.
        offset -= batchSize
        summary.attempted -= batch.length
        continue
      }
      if (err instanceof KeepaFatalRequestError) {
        log(`keepa-backfill: fatal batch error: ${err.message}`)
        for (const asin of batch) {
          markCheckpoint(db, asin, 'failed', null, err.message, now())
          summary.failed += 1
        }
        continue
      }
      // Transient / unexpected — mark batch failed, continue.
      const message = err instanceof Error ? err.message : String(err)
      log(`keepa-backfill: batch failed: ${message}`)
      for (const asin of batch) {
        markCheckpoint(db, asin, 'failed', null, message, now())
        summary.failed += 1
      }
      continue
    }

    const products = response.products
    const byAsin = new Map<string, Record<string, unknown>>()
    for (const product of products) {
      if (!product || typeof product !== 'object') continue
      const asin = typeof product.asin === 'string'
        ? normalizeAsin(product.asin)
        : ''
      if (asin) byAsin.set(asin, product)
    }

    const tokensConsumed = response.tokensConsumed
    const perAsinTokens = products.length > 0
      ? Math.max(0, Math.round(tokensConsumed / products.length))
      : Math.max(0, Math.round(tokensConsumed / Math.max(batch.length, 1)))

    tokensObserved += tokensConsumed
    asinsObserved += Math.max(products.filter(Boolean).length, 1)
    summary.tokensSpent += tokensConsumed

    for (const asin of batch) {
      const product = byAsin.get(asin)
      if (!product) {
        markCheckpoint(db, asin, 'not_found', 0, null, now())
        summary.notFound += 1
        log(`keepa-backfill: not_found ${asin}`)
        continue
      }

      try {
        commitAsin(db, asin, product, perAsinTokens, now())
        summary.done += 1
        log(`keepa-backfill: done ${asin}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        markCheckpoint(db, asin, 'failed', null, message, now())
        summary.failed += 1
        log(`keepa-backfill: failed ${asin}: ${message}`)
      }
    }

    // Token pacing before next batch. Keepa fires any request while the
    // balance is POSITIVE (cost may drive it negative, repaid at refillRate),
    // so optimal cadence waits only for balance > 0 — NOT for the full
    // next-batch cost. Waiting for full cost halves throughput (observed
    // live 2026-07-23: 11/hr vs the correct 21.4/hr).
    const remaining = work.length - (offset + batch.length)
    if (remaining > 0) {
      const tokensLeft = response.tokensLeft
      if (tokensLeft <= 0) {
        const refillRate = Math.max(response.refillRate, 0.0001) // tokens per minute
        const waitMinutes = (1 - tokensLeft) / refillRate
        const waitMs = Math.ceil(waitMinutes * 60_000) + 5_000
        log(
          `keepa-backfill: pacing — tokensLeft=${tokensLeft}; sleep ${Math.ceil(waitMs / 1000)}s until balance positive`,
        )
        await sleep(waitMs)
      }
    }
  }

  log(
    `keepa-backfill: finished attempted=${summary.attempted} done=${summary.done} ` +
    `notFound=${summary.notFound} failed=${summary.failed} tokens=${summary.tokensSpent}`,
  )
  return summary
}

function commitAsin(
  db: DatabaseHandle,
  asin: string,
  product: Record<string, unknown>,
  tokensCost: number,
  at: Date,
): void {
  const domain = typeof product.domainId === 'number' ? product.domainId : 1
  const payload = gzipSync(Buffer.from(JSON.stringify(product), 'utf8'))
  const points = normalizeKeepaProduct({
    asin,
    csv: product.csv as Array<number[] | null> | null | undefined,
  })
  const fetchedAt = at.toISOString()

  db.transaction(() => {
    db.prepare(`
      INSERT INTO keepa_raw (asin, domain, fetched_at, tokens_cost, payload)
      VALUES (@asin, @domain, @fetched_at, @tokens_cost, @payload)
      ON CONFLICT(asin) DO UPDATE SET
        domain = excluded.domain,
        fetched_at = excluded.fetched_at,
        tokens_cost = excluded.tokens_cost,
        payload = excluded.payload
    `).run({
      asin,
      domain,
      fetched_at: fetchedAt,
      tokens_cost: tokensCost,
      payload,
    })

    db.prepare('DELETE FROM keepa_points WHERE asin = ?').run(asin)

    const insertPoint = db.prepare(`
      INSERT OR IGNORE INTO keepa_points (asin, metric, ts, value)
      VALUES (@asin, @metric, @ts, @value)
    `)
    for (const point of points) {
      insertPoint.run({
        asin: point.asin,
        metric: point.metric,
        ts: point.ts,
        value: point.value,
      })
    }

    db.prepare(`
      INSERT INTO keepa_checkpoint (asin, status, tokens_spent, last_error, updated_at)
      VALUES (@asin, 'done', @tokens_spent, NULL, @updated_at)
      ON CONFLICT(asin) DO UPDATE SET
        status = 'done',
        tokens_spent = excluded.tokens_spent,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run({
      asin,
      tokens_spent: tokensCost,
      updated_at: fetchedAt,
    })
  })()
}

function markCheckpoint(
  db: DatabaseHandle,
  asin: string,
  status: 'pending' | 'done' | 'failed' | 'not_found',
  tokensSpent: number | null,
  lastError: string | null,
  at: Date,
): void {
  // Never overwrite a terminal success with failed from a later retry race.
  const existing = db.prepare(
    'SELECT status FROM keepa_checkpoint WHERE asin = ?',
  ).get(asin) as { status: string } | undefined
  if (existing && TERMINAL.has(existing.status) && status === 'failed') {
    return
  }

  db.prepare(`
    INSERT INTO keepa_checkpoint (asin, status, tokens_spent, last_error, updated_at)
    VALUES (@asin, @status, @tokens_spent, @last_error, @updated_at)
    ON CONFLICT(asin) DO UPDATE SET
      status = excluded.status,
      tokens_spent = COALESCE(excluded.tokens_spent, keepa_checkpoint.tokens_spent),
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run({
    asin,
    status,
    tokens_spent: tokensSpent,
    last_error: lastError,
    updated_at: at.toISOString(),
  })
}
