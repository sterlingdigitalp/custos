export type Fetch = typeof fetch

export interface LwaCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

interface LwaTokenResponse {
  access_token?: unknown
  expires_in?: unknown
  error_description?: unknown
  error?: unknown
}

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'
const EXPIRY_BUFFER_MS = 60_000

async function responseDetail(response: Response): Promise<string> {
  const text = await response.text()
  if (text === '') return response.statusText || `HTTP ${response.status}`
  try {
    const body = JSON.parse(text) as LwaTokenResponse
    if (typeof body.error_description === 'string') return body.error_description
    if (typeof body.error === 'string') return body.error
  } catch {
    // Preserve Amazon's non-JSON response text.
  }
  return text
}

export class LwaTokenManager {
  private accessToken: string | null = null
  private expiresAt = 0

  constructor(
    private readonly credentials: LwaCredentials,
    private readonly fetchImpl: Fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken !== null && this.now() < this.expiresAt - EXPIRY_BUFFER_MS) {
      return this.accessToken
    }
    const response = await this.fetchImpl(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
      }),
    })
    if (!response.ok) {
      throw new Error(`LWA token exchange failed (${response.status}): ${await responseDetail(response)}`)
    }
    const body = await response.json() as LwaTokenResponse
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error('LWA token exchange returned no access_token')
    }
    if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in)) {
      throw new Error('LWA token exchange returned an invalid expires_in')
    }
    this.accessToken = body.access_token
    this.expiresAt = this.now() + body.expires_in * 1_000
    return this.accessToken
  }
}
