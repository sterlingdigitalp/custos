import {
  insertAlertEvent,
  latestTwoForAsin,
  listActiveAlerts,
  maxPriceInWindow,
  updateAlert,
  type Alert,
  type Snapshot,
} from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'

function priceOf(snapshot: Snapshot): number | null {
  return snapshot.buyBoxPrice ?? snapshot.lowestNewPrice
}

function hasOfferOrPrice(snapshot: Snapshot): boolean {
  return (snapshot.offerCount ?? 0) > 0 ||
    (snapshot.fbaOfferCount ?? 0) > 0 ||
    snapshot.buyBoxPrice !== null ||
    snapshot.lowestNewPrice !== null ||
    snapshot.lowestFbaPrice !== null
}

function isCoolingDown(alert: Alert, now: Date): boolean {
  if (!alert.lastFiredAt) {
    return false
  }
  const lastFiredMs = Date.parse(alert.lastFiredAt)
  if (!Number.isFinite(lastFiredMs)) {
    return false
  }
  return now.getTime() - lastFiredMs < Math.max(0, alert.cooldownHours) * 3_600_000
}

function evaluateRule(
  db: DatabaseHandle,
  alert: Alert,
  latest: Snapshot,
  previous: Snapshot | undefined,
  now: Date,
): string | null {
  const currentPrice = priceOf(latest)
  switch (alert.ruleType) {
    case 'price_below':
      if (alert.threshold !== null && currentPrice !== null && currentPrice <= alert.threshold) {
        return `${alert.asin} price $${currentPrice.toFixed(2)} is at or below $${alert.threshold.toFixed(2)}`
      }
      return null

    case 'drop_percent': {
      if (alert.threshold === null || currentPrice === null) {
        return null
      }
      const windowMax = maxPriceInWindow(db, alert.asin, alert.windowHours, now)
      if (windowMax === null || windowMax <= 0) {
        return null
      }
      const dropPercent = ((windowMax - currentPrice) / windowMax) * 100
      if (dropPercent >= alert.threshold) {
        return `${alert.asin} price fell ${dropPercent.toFixed(1)}% from the ${alert.windowHours}h high $${windowMax.toFixed(2)} to $${currentPrice.toFixed(2)}`
      }
      return null
    }

    case 'back_in_stock':
      if (previous && !hasOfferOrPrice(previous) && hasOfferOrPrice(latest)) {
        const detail = currentPrice === null ? 'with an available offer' : `at $${currentPrice.toFixed(2)}`
        return `${alert.asin} is back in stock ${detail}`
      }
      return null

    case 'rank_below':
      if (
        alert.threshold !== null &&
        previous?.salesRank !== null &&
        previous?.salesRank !== undefined &&
        latest.salesRank !== null &&
        previous.salesRank > alert.threshold &&
        latest.salesRank <= alert.threshold
      ) {
        return `${alert.asin} sales rank improved from #${previous.salesRank} to #${latest.salesRank}, crossing #${alert.threshold}`
      }
      return null

    case 'buybox_change':
      if (
        previous?.buyBoxPrice !== null &&
        previous?.buyBoxPrice !== undefined &&
        latest.buyBoxPrice !== null
      ) {
        const previousCents = Math.round(previous.buyBoxPrice * 100)
        const latestCents = Math.round(latest.buyBoxPrice * 100)
        const changeCents = latestCents - previousCents
        if (Math.abs(changeCents) > 1) {
          const change = changeCents / 100
          return `${alert.asin} Buy Box changed from $${previous.buyBoxPrice.toFixed(2)} to $${latest.buyBoxPrice.toFixed(2)} (${change >= 0 ? '+' : '-'}$${Math.abs(change).toFixed(2)})`
        }
      }
      return null
  }
}

export function evaluateAlerts(db: DatabaseHandle, now: Date | string): number {
  const evaluationTime = typeof now === 'string' ? new Date(now) : now
  const ts = evaluationTime.toISOString()
  let fired = 0

  for (const alert of listActiveAlerts(db)) {
    if (isCoolingDown(alert, evaluationTime)) {
      continue
    }
    const [latest, previous] = latestTwoForAsin(db, alert.asin)
    if (!latest) {
      continue
    }
    const message = evaluateRule(db, alert, latest, previous, evaluationTime)
    if (!message) {
      continue
    }
    db.transaction(() => {
      insertAlertEvent(db, {
        alertId: alert.id,
        asin: alert.asin,
        ts,
        message,
        delivered: false,
      })
      updateAlert(db, alert.id, { lastFiredAt: ts })
    })()
    fired += 1
  }

  return fired
}
