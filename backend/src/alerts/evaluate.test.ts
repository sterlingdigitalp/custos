import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createAlert,
  getAlertById,
  insertSnapshot,
  listUnreadAlertEvents,
  type CreateSnapshotInput,
} from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import { evaluateAlerts } from './evaluate.js'

const NOW = new Date('2026-03-10T12:00:00.000Z')

function ts(hoursAgo: number): string {
  return new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString()
}

function addSnapshot(
  db: DatabaseHandle,
  hoursAgo: number,
  changes: Partial<CreateSnapshotInput>,
): void {
  insertSnapshot(db, {
    asin: 'A1',
    ts: ts(hoursAgo),
    buyBoxPrice: null,
    lowestNewPrice: null,
    lowestFbaPrice: null,
    offerCount: null,
    fbaOfferCount: null,
    salesRank: null,
    rankCategory: null,
    ...changes,
  })
}

describe('evaluateAlerts', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  afterEach(() => db.close())

  it('fires price_below using lowest-new fallback and records an undelivered event', () => {
    const alert = createAlert(db, { asin: 'A1', ruleType: 'price_below', threshold: 10 })
    addSnapshot(db, 0, { lowestNewPrice: 9.5 })
    expect(evaluateAlerts(db, NOW)).toBe(1)
    expect(listUnreadAlertEvents(db)[0]).toMatchObject({
      alertId: alert.id,
      asin: 'A1',
      delivered: false,
    })
    expect(listUnreadAlertEvents(db)[0].message).toContain('A1 price $9.50')
    expect(getAlertById(db, alert.id)?.lastFiredAt).toBe(NOW.toISOString())
  })

  it('does not fire price_below when the preferred Buy Box price is above threshold', () => {
    createAlert(db, { asin: 'A1', ruleType: 'price_below', threshold: 10 })
    addSnapshot(db, 0, { buyBoxPrice: 11, lowestNewPrice: 8 })
    expect(evaluateAlerts(db, NOW)).toBe(0)
  })

  it('fires drop_percent against the window maximum, not the previous point', () => {
    createAlert(db, {
      asin: 'A1', ruleType: 'drop_percent', threshold: 10, windowHours: 24,
    })
    addSnapshot(db, 20, { buyBoxPrice: 100 })
    addSnapshot(db, 1, { buyBoxPrice: 80 })
    addSnapshot(db, 0, { buyBoxPrice: 85 })
    expect(evaluateAlerts(db, NOW)).toBe(1)
    expect(listUnreadAlertEvents(db)[0].message).toContain('15.0%')
    expect(listUnreadAlertEvents(db)[0].message).toContain('$100.00')
  })

  it('does not fire drop_percent below the configured percentage', () => {
    createAlert(db, {
      asin: 'A1', ruleType: 'drop_percent', threshold: 16, windowHours: 24,
    })
    addSnapshot(db, 20, { buyBoxPrice: 100 })
    addSnapshot(db, 1, { buyBoxPrice: 80 })
    addSnapshot(db, 0, { buyBoxPrice: 85 })
    expect(evaluateAlerts(db, NOW)).toBe(0)
  })

  it('fires back_in_stock on unavailable-to-available transition', () => {
    createAlert(db, { asin: 'A1', ruleType: 'back_in_stock' })
    addSnapshot(db, 1, {})
    addSnapshot(db, 0, { offerCount: 1 })
    expect(evaluateAlerts(db, NOW)).toBe(1)
    expect(listUnreadAlertEvents(db)[0].message).toContain('A1 is back in stock')
  })

  it('does not fire back_in_stock when the previous snapshot was available', () => {
    createAlert(db, { asin: 'A1', ruleType: 'back_in_stock' })
    addSnapshot(db, 1, { lowestFbaPrice: 20 })
    addSnapshot(db, 0, { offerCount: 1, lowestFbaPrice: 21 })
    expect(evaluateAlerts(db, NOW)).toBe(0)
  })

  it('fires rank_below only when improving through the threshold', () => {
    createAlert(db, { asin: 'A1', ruleType: 'rank_below', threshold: 1000 })
    addSnapshot(db, 1, { salesRank: 1200 })
    addSnapshot(db, 0, { salesRank: 900 })
    expect(evaluateAlerts(db, NOW)).toBe(1)
    expect(listUnreadAlertEvents(db)[0].message).toContain('from #1200 to #900')
  })

  it('does not fire rank_below when both points were already below threshold', () => {
    createAlert(db, { asin: 'A1', ruleType: 'rank_below', threshold: 1000 })
    addSnapshot(db, 1, { salesRank: 900 })
    addSnapshot(db, 0, { salesRank: 800 })
    expect(evaluateAlerts(db, NOW)).toBe(0)
  })

  it('fires buybox_change for a movement greater than one cent', () => {
    createAlert(db, { asin: 'A1', ruleType: 'buybox_change' })
    addSnapshot(db, 1, { buyBoxPrice: 20 })
    addSnapshot(db, 0, { buyBoxPrice: 20.02 })
    expect(evaluateAlerts(db, NOW)).toBe(1)
    expect(listUnreadAlertEvents(db)[0].message).toContain('$20.00 to $20.02')
  })

  it('does not fire buybox_change for a movement of exactly one cent', () => {
    createAlert(db, { asin: 'A1', ruleType: 'buybox_change' })
    addSnapshot(db, 1, { buyBoxPrice: 20 })
    addSnapshot(db, 0, { buyBoxPrice: 20.01 })
    expect(evaluateAlerts(db, NOW)).toBe(0)
  })

  it('suppresses an otherwise firing alert during its cooldown', () => {
    createAlert(db, {
      asin: 'A1',
      ruleType: 'price_below',
      threshold: 10,
      cooldownHours: 24,
      lastFiredAt: ts(1),
    })
    addSnapshot(db, 0, { buyBoxPrice: 5 })
    expect(evaluateAlerts(db, NOW)).toBe(0)
    expect(listUnreadAlertEvents(db)).toEqual([])
  })

  it('fires again once the cooldown has elapsed', () => {
    createAlert(db, {
      asin: 'A1',
      ruleType: 'price_below',
      threshold: 10,
      cooldownHours: 24,
      lastFiredAt: ts(24),
    })
    addSnapshot(db, 0, { buyBoxPrice: 5 })
    expect(evaluateAlerts(db, NOW)).toBe(1)
  })
})
