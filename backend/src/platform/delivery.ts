// Hub outbox delivery worker — ported from aurora's backend/src/platform/delivery.ts.
// Drains due platform_outbox pending rows and POSTs each to POST ${baseUrl}/events.

import type { DatabaseHandle } from '../db/schema.js'
import {
  duePendingEvents,
  markDelivered,
  markPoison,
  markRetry,
  type OutboxRecord,
} from './outbox.js'

export interface HubEndpointConfig {
  baseUrl: string
  token: string
}

export interface HubDeliveryDeps {
  fetch?: typeof fetch
  now?: () => number
}

export interface HubDeliveryTickResult {
  delivered: number
  retried: number
  poisoned: number
  /** True if a 401/403 halted the batch — remaining due records were not attempted. */
  stopped: boolean
}

interface HubAckBody {
  eventId?: string
  sequence?: number
  receivedAt?: string
  duplicate?: boolean
}

export const BACKOFF_CAP_MS = 300_000

/** Exponential backoff with jitter, capped at BACKOFF_CAP_MS (5 minutes). */
export function computeBackoffMs(attempts: number, random: () => number = Math.random): number {
  const exponential = 2 ** Math.max(0, attempts) * 1_000
  return Math.min(exponential + random() * 1_000, BACKOFF_CAP_MS)
}

/** Parses a Retry-After header (delta-seconds or HTTP-date) into a millisecond delay. */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000
  const dateMs = Date.parse(trimmed)
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text ? `HTTP ${res.status}: ${text.slice(0, 500)}` : `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

type DeliverOutcome = 'delivered' | 'retried' | 'poisoned' | 'stopped'

/**
 * Drains due platform_outbox pending rows to the Hub.
 * No-op when hub endpoint is undefined (standalone mode).
 */
export class HubDeliveryWorker {
  private readonly db: DatabaseHandle
  private readonly hub: HubEndpointConfig | undefined
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  /** Set true after 401/403 — surfaces for operator visibility. */
  private halted = false

  constructor(db: DatabaseHandle, hub: HubEndpointConfig | undefined, deps: HubDeliveryDeps = {}) {
    this.db = db
    this.hub = hub
    this.fetchImpl = deps.fetch ?? fetch
    this.now = deps.now ?? (() => Date.now())
  }

  get isHalted(): boolean {
    return this.halted
  }

  /** Process all currently-due pending records once. */
  async tick(): Promise<HubDeliveryTickResult> {
    const result: HubDeliveryTickResult = { delivered: 0, retried: 0, poisoned: 0, stopped: false }
    if (!this.hub) return result
    if (this.halted) {
      result.stopped = true
      return result
    }
    const hub = this.hub

    const nowMs = this.now()
    const due = duePendingEvents(this.db, new Date(nowMs).toISOString())

    for (const record of due) {
      const outcome = await this.deliverOne(record, hub, nowMs)
      if (outcome === 'delivered') result.delivered++
      else if (outcome === 'retried') result.retried++
      else if (outcome === 'poisoned') result.poisoned++
      else if (outcome === 'stopped') {
        this.halted = true
        result.stopped = true
        console.error(
          '[history-delivery] halted batch on auth failure (401/403); remaining due records deferred',
        )
        break
      }
    }

    return result
  }

  private async deliverOne(
    record: OutboxRecord,
    hub: HubEndpointConfig,
    nowMs: number,
  ): Promise<DeliverOutcome> {
    let res: Response
    try {
      res = await this.fetchImpl(`${hub.baseUrl}/events`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hub.token}`,
          'Content-Type': 'application/json',
        },
        body: record.envelope,
      })
    } catch (err) {
      this.scheduleRetry(record, null, nowMs, err instanceof Error ? err.message : String(err))
      return 'retried'
    }

    if (res.status === 401 || res.status === 403) {
      return 'stopped'
    }

    if (res.status === 200 || res.status === 201) {
      const body = (await res.json().catch(() => null)) as HubAckBody | null
      // Matching eventId ack → delivered. {duplicate:true} with matching id is also delivered.
      if (body && body.eventId === record.eventId) {
        markDelivered(this.db, record.id, {
          deliveredAt: body.receivedAt ?? new Date(nowMs).toISOString(),
          sequence: body.sequence ?? null,
        })
        return 'delivered'
      }
      this.scheduleRetry(record, res, nowMs, 'ack eventId did not match record')
      return 'retried'
    }

    if (res.status === 422) {
      markPoison(this.db, record.id, { lastError: await safeErrorText(res) })
      return 'poisoned'
    }

    if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) {
      this.scheduleRetry(record, res, nowMs, await safeErrorText(res))
      return 'retried'
    }

    this.scheduleRetry(record, res, nowMs, await safeErrorText(res))
    return 'retried'
  }

  private scheduleRetry(
    record: OutboxRecord,
    res: Response | null,
    nowMs: number,
    message: string,
  ): void {
    const attempts = record.attempts + 1
    const computed = computeBackoffMs(attempts)
    const retryAfterMs = res ? parseRetryAfterMs(res.headers.get('Retry-After'), nowMs) : null
    const delayMs = retryAfterMs != null ? Math.max(retryAfterMs, computed) : computed
    markRetry(this.db, record.id, {
      lastError: message,
      nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
    })
  }
}
