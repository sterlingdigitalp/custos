// Transactional outbox for history events (PLATFORM-INTEGRATION.md D5).
// Ported from aurora's backend/src/platform/outbox.ts.
//
// enqueueOutboxEvent never opens its own transaction: callers pair it with a
// domain write inside their own db.transaction(...).

import type { DatabaseHandle } from '../db/schema.js'

export type OutboxStatus = 'pending' | 'delivered' | 'failed' | 'poison'

export interface OutboxRecord {
  id: number
  eventId: string
  eventType: string
  /** Full JSON PlatformEvent envelope, verbatim. */
  envelope: string
  status: OutboxStatus
  attempts: number
  lastError: string | null
  nextAttemptAt: string | null
  enqueuedAt: string
  deliveredAt: string | null
  sequence: number | null
}

interface OutboxRow {
  id: number
  event_id: string
  event_type: string
  envelope: string
  status: OutboxStatus
  attempts: number
  last_error: string | null
  next_attempt_at: string | null
  enqueued_at: string
  delivered_at: string | null
  sequence: number | null
}

function fromRow(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    envelope: row.envelope,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    enqueuedAt: row.enqueued_at,
    deliveredAt: row.delivered_at,
    sequence: row.sequence,
  }
}

export interface EnqueueOutboxEventInput {
  eventId: string
  eventType: string
  /** Full JSON PlatformEvent envelope, verbatim. */
  envelope: string
  enqueuedAt?: string
}

/**
 * Enqueue a platform event envelope. Idempotent on eventId (INSERT OR IGNORE).
 * Does NOT open a transaction — caller wraps with domain write.
 */
export function enqueueOutboxEvent(db: DatabaseHandle, input: EnqueueOutboxEventInput): void {
  db.prepare(`
    INSERT OR IGNORE INTO platform_outbox (
      event_id, event_type, envelope, status, attempts, enqueued_at
    ) VALUES (@eventId, @eventType, @envelope, 'pending', 0, @enqueuedAt)
  `).run({
    eventId: input.eventId,
    eventType: input.eventType,
    envelope: input.envelope,
    enqueuedAt: input.enqueuedAt ?? new Date().toISOString(),
  })
}

/** Pending outbox records whose next_attempt_at has arrived (or was never set). */
export function duePendingEvents(db: DatabaseHandle, nowIso: string): OutboxRecord[] {
  const rows = db.prepare(`
    SELECT id, event_id, event_type, envelope, status, attempts, last_error,
           next_attempt_at, enqueued_at, delivered_at, sequence
    FROM platform_outbox
    WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY id
  `).all(nowIso) as OutboxRow[]
  return rows.map(fromRow)
}

export interface MarkDeliveredInput {
  deliveredAt: string
  sequence?: number | null
}

export function markDelivered(db: DatabaseHandle, id: number, input: MarkDeliveredInput): void {
  db.prepare(`
    UPDATE platform_outbox
    SET status = 'delivered', delivered_at = @deliveredAt, sequence = @sequence,
        attempts = attempts + 1
    WHERE id = @id
  `).run({ id, deliveredAt: input.deliveredAt, sequence: input.sequence ?? null })
}

export interface MarkRetryInput {
  nextAttemptAt: string
  lastError: string
}

/** Record a failed delivery attempt. Status stays 'pending'. */
export function markRetry(db: DatabaseHandle, id: number, input: MarkRetryInput): void {
  db.prepare(`
    UPDATE platform_outbox
    SET attempts = attempts + 1, last_error = @lastError, next_attempt_at = @nextAttemptAt
    WHERE id = @id
  `).run({ id, lastError: input.lastError, nextAttemptAt: input.nextAttemptAt })
}

/** Alias used by the delivery worker — same as markRetry. */
export const scheduleRetry = markRetry

export interface MarkPoisonInput {
  lastError: string
}

/** Mark a record as permanently rejected (schema-invalid at the Hub). */
export function markPoison(db: DatabaseHandle, id: number, input: MarkPoisonInput): void {
  db.prepare(`
    UPDATE platform_outbox
    SET status = 'poison', attempts = attempts + 1, last_error = @lastError
    WHERE id = @id
  `).run({ id, lastError: input.lastError })
}

export function poisonCount(db: DatabaseHandle): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM platform_outbox WHERE status = 'poison'`)
    .get() as { c: number }).c
}
