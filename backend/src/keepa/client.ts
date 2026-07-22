// Keepa Product API client (injectable fetch). Never logs the API key.

export type FetchImpl = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

export interface KeepaProductResponse {
  products: Array<Record<string, unknown> | null>
  tokensLeft: number
  refillIn: number
  refillRate: number
  tokensConsumed: number
}

/** HTTP 429 / 402 — token bucket empty; carry refillIn (ms) for pacing. */
export class KeepaTokensExhaustedError extends Error {
  readonly name = 'KeepaTokensExhaustedError'
  constructor(
    message: string,
    readonly status: 429 | 402,
    readonly refillIn: number,
  ) {
    super(message)
  }
}

/** Per-request fatal (e.g. 400 asin issues) — do not retry the batch. */
export class KeepaFatalRequestError extends Error {
  readonly name = 'KeepaFatalRequestError'
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Exhausted 5xx/network retries. */
export class KeepaTransientError extends Error {
  readonly name = 'KeepaTransientError'
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface KeepaClientOptions {
  apiKey: string
  fetchImpl?: FetchImpl
  /** Domain id (1 = com). Default 1. */
  domain?: number
  /** Max attempts for 5xx/network (default 3). */
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_MAX_ATTEMPTS = 3

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  if (typeof code === 'string' && (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  )) {
    return true
  }
  return err.name === 'TypeError' || /fetch failed|network/i.test(err.message)
}

export class KeepaClient {
  private readonly apiKey: string
  private readonly fetchImpl: FetchImpl
  private readonly domain: number
  private readonly maxAttempts: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: KeepaClientOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new Error('Keepa API key is required')
    }
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.domain = options.domain ?? 1
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.sleep = options.sleep ?? defaultSleep
  }

  /**
   * GET /product?key&domain&asin=<csv>≤100&history=1&buybox=1
   * fetch decompresses gzip automatically (Accept-Encoding).
   */
  async getProducts(asins: string[]): Promise<KeepaProductResponse> {
    if (asins.length === 0) {
      throw new Error('getProducts requires at least one ASIN')
    }
    if (asins.length > 100) {
      throw new Error('getProducts batch size max is 100')
    }

    const url = new URL('https://api.keepa.com/product')
    url.searchParams.set('key', this.apiKey)
    url.searchParams.set('domain', String(this.domain))
    url.searchParams.set('asin', asins.map((a) => a.trim().toUpperCase()).join(','))
    url.searchParams.set('history', '1')
    url.searchParams.set('buybox', '1')

    let lastError: Error | undefined

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
        })
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (!isNetworkError(err) || attempt === this.maxAttempts) {
          throw new KeepaTransientError(
            `Keepa network error: ${lastError.message}`,
          )
        }
        await this.sleep(backoffMs(attempt))
        continue
      }

      if (response.status === 429 || response.status === 402) {
        const bodyText = await safeText(response)
        const refillIn = parseRefillIn(bodyText, response)
        throw new KeepaTokensExhaustedError(
          `Keepa tokens exhausted (HTTP ${response.status})`,
          response.status as 429 | 402,
          refillIn,
        )
      }

      if (response.status === 400) {
        const bodyText = await safeText(response)
        // ASIN / request parameter issues are fatal for this batch.
        if (/asin/i.test(bodyText) || /parameter/i.test(bodyText) || bodyText.length > 0) {
          throw new KeepaFatalRequestError(
            `Keepa bad request: ${truncate(bodyText)}`,
            400,
          )
        }
        throw new KeepaFatalRequestError('Keepa bad request', 400)
      }

      if (response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`)
        if (attempt === this.maxAttempts) {
          throw new KeepaTransientError(
            `Keepa server error after ${this.maxAttempts} attempts: HTTP ${response.status}`,
            response.status,
          )
        }
        await this.sleep(backoffMs(attempt))
        continue
      }

      if (!response.ok) {
        const bodyText = await safeText(response)
        throw new KeepaFatalRequestError(
          `Keepa unexpected HTTP ${response.status}: ${truncate(bodyText)}`,
          response.status,
        )
      }

      const json = await response.json() as Record<string, unknown>
      return parseProductResponse(json)
    }

    throw new KeepaTransientError(
      `Keepa request failed after ${this.maxAttempts} attempts: ${lastError?.message ?? 'unknown'}`,
    )
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000)
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function truncate(text: string, max = 200): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function parseRefillIn(bodyText: string, response: Response): number {
  try {
    const json = JSON.parse(bodyText) as { refillIn?: unknown }
    if (typeof json.refillIn === 'number' && Number.isFinite(json.refillIn)) {
      return json.refillIn
    }
  } catch {
    // fall through
  }
  const header = response.headers.get('x-refill-in') ?? response.headers.get('refill-in')
  if (header) {
    const n = Number(header)
    if (Number.isFinite(n)) return n
  }
  return 60_000
}

function parseProductResponse(json: Record<string, unknown>): KeepaProductResponse {
  const products = Array.isArray(json.products)
    ? (json.products as Array<Record<string, unknown> | null>)
    : []
  return {
    products,
    tokensLeft: numberOr(json.tokensLeft, 0),
    refillIn: numberOr(json.refillIn, 0),
    refillRate: numberOr(json.refillRate, 1),
    tokensConsumed: numberOr(json.tokensConsumed, 0),
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
