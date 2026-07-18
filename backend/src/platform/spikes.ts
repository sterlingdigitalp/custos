// Rank-spike inference (PLATFORM-INTEGRATION.md §2 history.rank.spike.v1).
// Consecutive snapshots where salesRank improves ≥ threshold% from a base
// worse than minBaseRank → one spike. Always records locally; emits to the
// outbox only when Hub is configured AND the ASIN has a registry mapping.

import { latestTwoForAsin, listProducts, getMappingByAsin } from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'
import type { HubConfig } from './config.js'
import { buildHistoryEvent } from './events.js'
import { enqueueOutboxEvent } from './outbox.js'

export interface SpikeDetectionOptions {
  /** Minimum improvement percent (default 30). */
  threshold?: number
  /** Previous rank must be strictly greater than this (default 1000). */
  minBaseRank?: number
  now?: Date
}

export interface SpikeDetectionResult {
  checked: number
  recorded: number
  emitted: number
  skippedNoPair: number
}

/**
 * For each active product, inspect the latest two snapshots. When a spike is
 * detected, INSERT OR IGNORE into history_spikes (dedup by asin+detected_at
 * where detected_at = latest snapshot ts). If the insert lands and config is
 * set with a product mapping, build + enqueue history.rank.spike.v1.
 */
export function detectAndRecordSpikes(
  db: DatabaseHandle,
  config: HubConfig | null,
  options: SpikeDetectionOptions = {},
): SpikeDetectionResult {
  const threshold = options.threshold ?? 30
  const minBaseRank = options.minBaseRank ?? 1_000
  const result: SpikeDetectionResult = {
    checked: 0,
    recorded: 0,
    emitted: 0,
    skippedNoPair: 0,
  }

  const products = listProducts(db, true)
  for (const product of products) {
    result.checked++
    const pair = latestTwoForAsin(db, product.asin)
    if (pair.length < 2) {
      result.skippedNoPair++
      continue
    }
    // latestTwoForAsin returns DESC (latest first)
    const latest = pair[0]!
    const previous = pair[1]!
    if (
      previous.salesRank === null ||
      latest.salesRank === null ||
      previous.salesRank <= minBaseRank
    ) {
      continue
    }

    const maxAfter = previous.salesRank * (1 - threshold / 100)
    if (latest.salesRank > maxAfter) continue

    const improvementPercent =
      ((previous.salesRank - latest.salesRank) / previous.salesRank) * 100
    const detectedAt = latest.ts
    const rankCategory = latest.rankCategory ?? previous.rankCategory ?? null

    const mapping = getMappingByAsin(db, product.asin)
    const canEmit = config !== null && mapping !== undefined

    db.transaction(() => {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO history_spikes (
          asin, detected_at, rank_before, rank_after, rank_category,
          improvement_percent, emitted_event_id
        ) VALUES (
          @asin, @detectedAt, @rankBefore, @rankAfter, @rankCategory,
          @improvementPercent, NULL
        )
      `).run({
        asin: product.asin,
        detectedAt,
        rankBefore: previous.salesRank,
        rankAfter: latest.salesRank,
        rankCategory,
        improvementPercent,
      })

      if (insert.changes === 0) return // already recorded (dedup)
      result.recorded++

      if (!canEmit || !config || !mapping) return

      const envelope = buildHistoryEvent({
        config,
        type: 'history.rank.spike.v1',
        productId: mapping.canonicalProductId,
        occurredAt: detectedAt,
        payload: {
          productId: mapping.canonicalProductId,
          detectedAt,
          rankBefore: previous.salesRank,
          rankAfter: latest.salesRank,
          rankCategory,
          improvementPercent,
          estimatedUnits: 1,
        },
      })
      enqueueOutboxEvent(db, {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        envelope: JSON.stringify(envelope),
      })
      db.prepare(`
        UPDATE history_spikes SET emitted_event_id = ?
        WHERE asin = ? AND detected_at = ?
      `).run(envelope.eventId, product.asin, detectedAt)
      result.emitted++
    })()
  }

  return result
}
