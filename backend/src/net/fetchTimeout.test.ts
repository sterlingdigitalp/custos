import { describe, expect, it } from 'vitest'

import { FetchTimeoutError, fetchWithTimeout, timeoutSignal } from './fetchTimeout.js'

function neverResolves(): Promise<Response> {
  return new Promise<Response>(() => {})
}

describe('fetchWithTimeout', () => {
  it('rejects with a FetchTimeoutError when the fetch never resolves — independent of the fetch honoring the signal', async () => {
    const start = Date.now()
    await expect(
      fetchWithTimeout(neverResolves, 'https://example.test', undefined, 20, 'test call'),
    ).rejects.toMatchObject({
      name: 'FetchTimeoutError',
      timeoutMs: 20,
    })
    // Actually raced past — did not hang for anything close to real network timescales.
    expect(Date.now() - start).toBeLessThan(2_000)
  })

  it('timeout error message states the elapsed budget', async () => {
    await expect(
      fetchWithTimeout(neverResolves, 'https://example.test', undefined, 33, 'widget fetch'),
    ).rejects.toThrow('widget fetch timed out after 33ms')
  })

  it('is unaffected when the fetch resolves normally (no regression)', async () => {
    const response = new Response('ok', { status: 200 })
    const fetchImpl = async (): Promise<Response> => response
    await expect(
      fetchWithTimeout(fetchImpl, 'https://example.test', undefined, 5_000, 'test call'),
    ).resolves.toBe(response)
  })

  it('a caller-supplied signal still aborts, and is distinguishable from a timeout', async () => {
    const controller = new AbortController()
    const promise = fetchWithTimeout(
      neverResolves,
      'https://example.test',
      { signal: controller.signal },
      5_000, // large budget — must not fire during this test
      'test call',
    )
    controller.abort()
    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.not.toBeInstanceOf(FetchTimeoutError)
  })

  it('combines a caller signal with the timeout budget rather than clobbering it', () => {
    const controller = new AbortController()
    const combined = timeoutSignal(5_000, controller.signal)
    expect(combined.aborted).toBe(false)
    controller.abort()
    expect(combined.aborted).toBe(true)
  })
})
