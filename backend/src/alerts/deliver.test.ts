import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAlert, getSettings, insertAlertEvent, listAlertEvents, updateSettings } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import { deliverPending, type Fetch } from './deliver.js'

describe('deliverPending', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  function pending(): void {
    const alert = createAlert(db, { asin: 'B0TEST', ruleType: 'price_below', threshold: 10 })
    insertAlertEvent(db, { alertId: alert.id, asin: 'B0TEST', message: 'Price is low' })
  }

  it('posts ntfy headers and marks successful delivery', async () => {
    pending()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: Fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response('ok')
    }
    const settings = updateSettings(db, { ntfyServer: 'https://ntfy.test/', ntfyTopic: 'my topic' })
    await expect(deliverPending(db, settings, fetchImpl)).resolves.toEqual({
      pending: 1, delivered: 1, failed: 0,
    })
    expect(calls[0].url).toBe('https://ntfy.test/my%20topic')
    expect(new Headers(calls[0].init?.headers).get('title')).toBe('Custos')
    expect(new Headers(calls[0].init?.headers).get('x-click')).toBe('https://www.amazon.com/dp/B0TEST')
    expect(calls[0].init?.body).toBe('Price is low')
    expect(listAlertEvents(db)[0]).toMatchObject({ delivered: true, deliveryError: null })
  })

  it('records delivery failure and never throws', async () => {
    pending()
    const settings = updateSettings(db, { ntfyTopic: 'custos' })
    const fetchImpl: Fetch = async () => new Response('service down', { status: 503 })
    await expect(deliverPending(db, settings, fetchImpl)).resolves.toMatchObject({ failed: 1 })
    expect(listAlertEvents(db)[0]).toMatchObject({
      delivered: false,
      deliveryError: 'ntfy request failed (503): service down',
    })
  })

  it('marks web-inbox-only events delivered when no topic exists', async () => {
    pending()
    await deliverPending(db, getSettings(db), async () => {
      throw new Error('fetch should not run')
    })
    expect(listAlertEvents(db)[0]).toMatchObject({
      delivered: true, deliveryError: 'no channel configured', isRead: false,
    })
  })
})
