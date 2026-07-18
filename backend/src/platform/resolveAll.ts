// Eager bootstrap resolve for all active ASINs missing a registry mapping
// (PLATFORM-INTEGRATION.md D3). Sequential with light pacing — there is no
// batch resolve API. Fatal auth (401/403) aborts immediately.

import {
  getProductByAsin,
  listActiveAsinsMissingMapping,
  upsertProductMapping,
} from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'
import { HubAuthError, type RegistryClient } from './registry.js'

export interface ResolveAllOptions {
  /** Sleep between sequential resolve calls (default 25ms). */
  paceMs?: number
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

export interface ResolveAllSummary {
  attempted: number
  resolved: number
  created: number
  conflicts: number
  failed: number
  /** ASIN-level conflict/failure detail for operator review. */
  details: Array<{ asin: string; kind: 'conflict' | 'failed'; message: string }>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function resolveAllProducts(
  db: DatabaseHandle,
  client: RegistryClient,
  options: ResolveAllOptions = {},
): Promise<ResolveAllSummary> {
  const paceMs = options.paceMs ?? 25
  const log = options.log ?? (() => {})
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => new Date())

  const missing = listActiveAsinsMissingMapping(db)
  const summary: ResolveAllSummary = {
    attempted: 0,
    resolved: 0,
    created: 0,
    conflicts: 0,
    failed: 0,
    details: [],
  }

  for (let i = 0; i < missing.length; i += 1) {
    const asin = missing[i]!
    summary.attempted += 1
    const product = getProductByAsin(db, asin)
    try {
      const result = await client.resolveProduct({
        asin,
        title: product?.title,
      })
      if (result.conflict) {
        summary.conflicts += 1
        summary.details.push({
          asin,
          kind: 'conflict',
          message: JSON.stringify(result.body),
        })
        log(`conflict ${asin}`)
      } else {
        upsertProductMapping(db, {
          asin,
          canonicalProductId: result.productId,
          registryVersion: result.registryVersion,
          createdByUs: result.created,
          resolvedAt: now().toISOString(),
        })
        summary.resolved += 1
        if (result.created) summary.created += 1
        log(`resolved ${asin} → ${result.productId}${result.created ? ' (created)' : ''}`)
      }
    } catch (err) {
      if (err instanceof HubAuthError) {
        log(`fatal auth error on ${asin}: ${err.message}`)
        throw err
      }
      const message = err instanceof Error ? err.message : String(err)
      summary.failed += 1
      summary.details.push({ asin, kind: 'failed', message })
      log(`failed ${asin}: ${message}`)
    }

    if (paceMs > 0 && i < missing.length - 1) {
      await sleep(paceMs)
    }
  }

  return summary
}
