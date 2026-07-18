// Hub Registry client for product resolve (PLATFORM-INTEGRATION.md D3).
// POST /registry/products/resolve — one product per call; source derives from
// the service credential (do not send source or accountId). Resolve is
// idempotent by identifier, so no Idempotency-Key (a key tied to a changing
// body would IDEMPOTENCY_CONFLICT on title updates).

import { isCanonicalId } from '@platform/contract'

import type { HubConfig } from './config.js'

export type FetchLike = typeof fetch
export type SleepFn = (ms: number) => Promise<void>

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const

export class HubAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HubAuthError'
  }
}

export interface ResolveProductInput {
  asin: string
  title?: string | null
}

export interface ResolveProductSuccess {
  status: 'resolved'
  productId: string
  registryVersion: number
  created: boolean
  conflictId: string | null
  conflict?: undefined
}

export interface ResolveProductConflict {
  conflict: true
  body: unknown
}

export type ResolveProductResult = ResolveProductSuccess | ResolveProductConflict

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text ? `HTTP ${res.status}: ${text.slice(0, 500)}` : `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export class RegistryClient {
  private readonly fetchImpl: FetchLike
  private readonly sleep: SleepFn

  constructor(
    private readonly config: HubConfig,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    sleep: SleepFn = defaultSleep,
  ) {
    this.fetchImpl = fetchImpl
    this.sleep = sleep
  }

  async resolveProduct(input: ResolveProductInput): Promise<ResolveProductResult> {
    const body: Record<string, string> = {
      marketplaceId: this.config.marketplaceId,
      asin: input.asin,
    }
    if (input.title != null && input.title !== '') {
      body.title = input.title
    }

    const url = `${this.config.baseUrl}/registry/products/resolve`
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(RETRY_BACKOFF_MS[attempt - 1]!)
      }

      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt === RETRY_BACKOFF_MS.length) {
          throw new Error(
            `registry resolve network error for ${input.asin} after ${attempt + 1} attempts: ${lastError.message}`,
          )
        }
        continue
      }

      if (res.status === 401 || res.status === 403) {
        const detail = await safeErrorText(res)
        throw new HubAuthError(
          `registry resolve auth failed (${res.status}) for ${input.asin}: ${detail}`,
          res.status,
        )
      }

      if (res.status === 409) {
        let conflictBody: unknown
        try {
          conflictBody = await res.json()
        } catch {
          conflictBody = await res.text().catch(() => null)
        }
        return { conflict: true, body: conflictBody }
      }

      if (res.status >= 500) {
        lastError = new Error(await safeErrorText(res))
        if (attempt === RETRY_BACKOFF_MS.length) {
          throw new Error(
            `registry resolve server error for ${input.asin} after ${attempt + 1} attempts: ${lastError.message}`,
          )
        }
        continue
      }

      if (!res.ok) {
        throw new Error(
          `registry resolve failed for ${input.asin}: ${await safeErrorText(res)}`,
        )
      }

      const payload = (await res.json()) as Record<string, unknown>
      if (payload.status !== 'resolved' || typeof payload.productId !== 'string') {
        throw new Error(
          `registry resolve unexpected response for ${input.asin}: ${JSON.stringify(payload)}`,
        )
      }
      if (!isCanonicalId(payload.productId, 'prd')) {
        throw new Error(
          `registry resolve returned non-canonical productId for ${input.asin}: ${JSON.stringify(payload.productId)}`,
        )
      }

      return {
        status: 'resolved',
        productId: payload.productId,
        registryVersion: Number(payload.registryVersion ?? 0),
        created: Boolean(payload.created),
        conflictId: typeof payload.conflictId === 'string' ? payload.conflictId : null,
      }
    }

    throw lastError ?? new Error(`registry resolve failed for ${input.asin}`)
  }
}
