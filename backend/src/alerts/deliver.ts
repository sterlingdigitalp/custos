import { updateAlertEventDelivery, type Settings } from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'

export type Fetch = typeof fetch

export interface DeliverySummary {
  pending: number
  delivered: number
  failed: number
}

function deliveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function deliverPending(
  db: DatabaseHandle,
  settings: Settings,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<DeliverySummary> {
  const events = db.prepare(`
    SELECT id, asin, message FROM alert_events WHERE delivered = 0 ORDER BY id
  `).all() as Array<{ id: number; asin: string; message: string }>
  const summary: DeliverySummary = { pending: events.length, delivered: 0, failed: 0 }

  for (const event of events) {
    if (!settings.ntfyTopic || settings.ntfyTopic.trim() === '') {
      updateAlertEventDelivery(db, event.id, true, 'no channel configured')
      summary.delivered += 1
      continue
    }

    const url = `${settings.ntfyServer.replace(/\/+$/, '')}/${encodeURIComponent(settings.ntfyTopic)}`
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Title: 'Custos',
          'X-Click': `https://www.amazon.com/dp/${encodeURIComponent(event.asin)}`,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: event.message,
      })
      if (!response.ok) {
        const detail = (await response.text()).trim()
        throw new Error(`ntfy request failed (${response.status})${detail ? `: ${detail}` : ''}`)
      }
      updateAlertEventDelivery(db, event.id, true, null)
      summary.delivered += 1
    } catch (error) {
      updateAlertEventDelivery(db, event.id, false, deliveryError(error))
      summary.failed += 1
    }
  }

  return summary
}
