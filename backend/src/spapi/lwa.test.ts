import { describe, expect, it } from 'vitest'

import { LwaTokenManager } from './lwa.js'

const CREDS = {
  clientId: 'test-client',
  clientSecret: 'FAKE-SECRET-DO-NOT-LEAK',
  refreshToken: 'FAKE-REFRESH-TOKEN-DO-NOT-LEAK',
}

function neverResolves(): Promise<Response> {
  return new Promise<Response>(() => {})
}

describe('LwaTokenManager timeouts', () => {
  it('rejects with a timeout error rather than hanging when fetch never resolves', async () => {
    const manager = new LwaTokenManager(CREDS, neverResolves, undefined, 20)
    await expect(manager.getAccessToken()).rejects.toMatchObject({
      name: 'FetchTimeoutError',
      timeoutMs: 20,
    })
  })

  it('timeout error message states the budget and never includes the client secret or refresh token', async () => {
    const manager = new LwaTokenManager(CREDS, neverResolves, undefined, 20)
    await expect(manager.getAccessToken()).rejects.toThrow('LWA token exchange timed out after 20ms')
    try {
      await manager.getAccessToken()
      throw new Error('expected getAccessToken to reject')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain(CREDS.clientSecret)
      expect(message).not.toContain(CREDS.refreshToken)
    }
  })

  it('is unaffected when fetch resolves normally (no regression)', async () => {
    const manager = new LwaTokenManager(CREDS, async () => new Response(
      JSON.stringify({ access_token: 'abc123', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ), undefined, 20)
    await expect(manager.getAccessToken()).resolves.toBe('abc123')
  })
})
