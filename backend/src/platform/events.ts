// History event envelope builder + self-validation (PLATFORM-INTEGRATION.md D4).
// Every payload is structurally validated against the rules encoded in
// historyEventPayloadSchemas (and the Hub historyPayload branch) before it
// can reach the outbox. No AJV / no new runtime deps — hand-rolled checker.

import {
  historyEventPayloadSchemas,
  isMoney,
  newId,
  type AccountId,
  type EventId,
  type MarketplaceId,
  type PlatformEvent,
  type ProductId,
} from '@platform/contract'

import type { HubConfig } from './config.js'

export type HistoryEventType = 'history.market.daily.v1' | 'history.rank.spike.v1'

export interface BuildHistoryEventOptions {
  config: HubConfig
  type: HistoryEventType
  productId: string
  payload: Record<string, unknown>
  /** ISO-8601 timestamp of the domain fact — never construction time. */
  occurredAt: string
}

const DATE_DAY = /^\d{4}-\d{2}-\d{2}$/
// Loose ISO-8601 date-time (Hub uses isoTimestamp; accept common forms).
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

type SchemaShape = {
  required: readonly string[]
  properties: Record<string, unknown>
}

function schemaFor(type: HistoryEventType): SchemaShape {
  return historyEventPayloadSchemas[type] as unknown as SchemaShape
}

function propertyKeys(schema: SchemaShape): string[] {
  return Object.keys(schema.properties).sort()
}

function fail(message: string): never {
  throw new Error(`history event payload invalid: ${message}`)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function assertExactKeys(payload: Record<string, unknown>, allowed: string[], label: string): void {
  const keys = Object.keys(payload).sort()
  const expected = [...allowed].sort()
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    fail(`${label} must have exact keys [${expected.join(', ')}] (got [${keys.join(', ')}])`)
  }
}

function assertNullableMoney(value: unknown, field: string): void {
  if (value === null) return
  if (!isMoney(value)) fail(`${field} must be Money or null`)
}

function assertNullableInteger(value: unknown, field: string, minimum: number): void {
  if (value === null) return
  if (!isInteger(value) || value < minimum) {
    fail(`${field} must be an integer >= ${minimum} or null`)
  }
}

function assertNullableString(value: unknown, field: string): void {
  if (value === null) return
  if (typeof value !== 'string') fail(`${field} must be a string or null`)
}

/**
 * Structural validator derived from historyEventPayloadSchemas + Hub
 * historyPayload exact-key rules. Throws on any violation so an invalid
 * payload never reaches the outbox.
 */
export function validateHistoryPayload(
  type: HistoryEventType,
  payload: Record<string, unknown>,
): void {
  const schema = schemaFor(type)
  const keys = propertyKeys(schema)
  assertExactKeys(payload, keys, 'payload')

  for (const req of schema.required) {
    if (!(req in payload) || payload[req] === undefined) {
      fail(`missing required key ${req}`)
    }
  }

  if (type === 'history.market.daily.v1') {
    if (typeof payload.productId !== 'string' || payload.productId.length === 0) {
      fail('productId must be a non-empty string')
    }
    if (typeof payload.date !== 'string' || !DATE_DAY.test(payload.date)) {
      fail('date must be YYYY-MM-DD')
    }
    if (!isInteger(payload.snapshotCount) || payload.snapshotCount < 1) {
      fail('snapshotCount must be an integer >= 1')
    }
    assertNullableMoney(payload.buyBoxMedian, 'buyBoxMedian')
    assertNullableMoney(payload.buyBoxMin, 'buyBoxMin')
    assertNullableMoney(payload.buyBoxMax, 'buyBoxMax')
    assertNullableMoney(payload.lowestNewMedian, 'lowestNewMedian')
    assertNullableMoney(payload.lowestFbaMedian, 'lowestFbaMedian')
    assertNullableInteger(payload.offerCountMedian, 'offerCountMedian', 0)
    assertNullableInteger(payload.fbaOfferCountMedian, 'fbaOfferCountMedian', 0)
    assertNullableInteger(payload.salesRankMedian, 'salesRankMedian', 1)
    assertNullableInteger(payload.salesRankMin, 'salesRankMin', 1)
    assertNullableInteger(payload.salesRankMax, 'salesRankMax', 1)
    assertNullableString(payload.rankCategory, 'rankCategory')
    assertNullableInteger(payload.estimatedSales, 'estimatedSales', 0)
    return
  }

  // history.rank.spike.v1
  if (typeof payload.productId !== 'string' || payload.productId.length === 0) {
    fail('productId must be a non-empty string')
  }
  if (typeof payload.detectedAt !== 'string' || !ISO_TIMESTAMP.test(payload.detectedAt)) {
    fail('detectedAt must be an ISO date-time')
  }
  if (!isInteger(payload.rankBefore) || payload.rankBefore < 1) {
    fail('rankBefore must be an integer >= 1')
  }
  if (!isInteger(payload.rankAfter) || payload.rankAfter < 1) {
    fail('rankAfter must be an integer >= 1')
  }
  assertNullableString(payload.rankCategory, 'rankCategory')
  if (!isFiniteNumber(payload.improvementPercent) || payload.improvementPercent < 0) {
    fail('improvementPercent must be a number >= 0')
  }
  if (!isInteger(payload.estimatedUnits) || payload.estimatedUnits < 1) {
    fail('estimatedUnits must be an integer >= 1')
  }
}

/**
 * Build a well-formed PlatformEvent for a history event type.
 * Self-validates the payload; throws if invalid.
 */
export function buildHistoryEvent(opts: BuildHistoryEventOptions): PlatformEvent {
  validateHistoryPayload(opts.type, opts.payload)
  return {
    eventId: newId('evt') as EventId,
    eventType: opts.type,
    schemaVersion: 1,
    source: 'history',
    accountId: opts.config.accountId as AccountId,
    marketplaceId: opts.config.marketplaceId as MarketplaceId,
    aggregate: { type: 'product', id: opts.productId },
    productId: opts.productId as ProductId,
    listingId: null,
    occurredAt: opts.occurredAt,
    correlationId: null,
    causationId: null,
    payload: opts.payload,
  }
}

/** Property key sets from the contract schemas — used by tests for cross-check. */
export function historyPayloadPropertyKeys(type: HistoryEventType): string[] {
  return propertyKeys(schemaFor(type))
}
