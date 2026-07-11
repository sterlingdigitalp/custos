import type { CatalogInfo, CustosApiClient, OfferSnapshot, SeedSearchResult } from './client.js'
import { LwaTokenManager, type Fetch } from './lwa.js'

const REGION_ENDPOINTS: Record<string, string> = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
}
const MAX_BATCH_SIZE = 20
const DEFAULT_PRICING_INTERVAL_MS = 10_000
const DEFAULT_CATALOG_INTERVAL_MS = 600

export interface LiveCustosClientSettings {
  lwaClientId: string
  lwaClientSecret: string
  refreshToken: string
  marketplaceId: string
  region: string
}

export type Sleep = (milliseconds: number) => Promise<void>

interface BatchItemResponse {
  status?: unknown
  request?: unknown
  body?: unknown
  payload?: unknown
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function endpointForRegion(region: string): string {
  const endpoint = REGION_ENDPOINTS[region]
  if (!endpoint) throw new Error(`Unsupported SP-API region: ${region}`)
  return endpoint
}

function retryDelayMilliseconds(value: string | null, now = Date.now()): number {
  if (value === null) return 10_000
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 10_000
}

function amazonError(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  if (!isRecord(value)) return undefined
  for (const key of ['message', 'error_description', 'details', 'reasonPhrase']) {
    if (typeof value[key] === 'string' && value[key] !== '') return value[key]
  }
  if (Array.isArray(value.errors)) {
    const errors = value.errors.map(amazonError).filter((item): item is string => item !== undefined)
    if (errors.length > 0) return errors.join('; ')
  }
  return amazonError(value.body)
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text()
  let detail = text
  if (text !== '') {
    try {
      detail = amazonError(JSON.parse(text)) ?? text
    } catch {
      // Preserve non-JSON response text.
    }
  }
  return new Error(`SP-API request failed (${response.status}): ${detail || response.statusText || `HTTP ${response.status}`}`)
}

function statusCode(response: BatchItemResponse): number | undefined {
  if (typeof response.status === 'number') return response.status
  if (isRecord(response.status) && typeof response.status.statusCode === 'number') {
    return response.status.statusCode
  }
  return undefined
}

function payloadFromBatch(response: BatchItemResponse): Record<string, unknown> | undefined {
  const payload = response.payload ?? (isRecord(response.body) ? response.body.payload : undefined)
  return isRecord(payload) ? payload : undefined
}

function requestAsin(response: BatchItemResponse): string | undefined {
  if (!isRecord(response.request) || typeof response.request.uri !== 'string') return undefined
  const match = response.request.uri.match(/^\/products\/pricing\/v0\/items\/([^/]+)\/offers$/)
  return match ? decodeURIComponent(match[1]) : undefined
}

function amount(value: unknown): number | null {
  if (!isRecord(value)) return null
  const raw = value.Amount
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return null
}

function landedPrice(offer: Record<string, unknown>): number | null {
  const listing = amount(offer.ListingPrice)
  if (listing === null) return null
  return listing + (amount(offer.Shipping) ?? 0)
}

function mapOffers(asin: string, payload: Record<string, unknown>): OfferSnapshot {
  const offers = Array.isArray(payload.Offers) ? payload.Offers : []
  let buyBoxPrice: number | null = null
  let lowestNewPrice: number | null = null
  let lowestFbaPrice: number | null = null
  let fbaOfferCount = 0

  for (const value of offers) {
    if (!isRecord(value)) continue
    const isFba = value.IsFulfilledByAmazon === true
    if (isFba) fbaOfferCount += 1
    const price = landedPrice(value)
    if (price === null) continue
    if (value.IsBuyBoxWinner === true && buyBoxPrice === null) buyBoxPrice = price
    if (lowestNewPrice === null || price < lowestNewPrice) lowestNewPrice = price
    if (isFba && (lowestFbaPrice === null || price < lowestFbaPrice)) lowestFbaPrice = price
  }

  return {
    asin,
    buyBoxPrice,
    lowestNewPrice,
    lowestFbaPrice,
    offerCount: offers.length,
    fbaOfferCount,
  }
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.find(isRecord)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function catalogImage(item: Record<string, unknown>): string | null {
  if (!Array.isArray(item.images)) return null
  for (const group of item.images) {
    if (!isRecord(group) || !Array.isArray(group.images)) continue
    const main = group.images.find((image) => isRecord(image) && image.variant === 'MAIN')
    if (isRecord(main) && typeof main.link === 'string') return main.link
  }
  return null
}

function catalogRank(item: Record<string, unknown>): { salesRank: number | null; rankCategory: string | null } {
  const ranks = firstRecord(item.salesRanks)
  if (!ranks) return { salesRank: null, rankCategory: null }
  const preferred = firstRecord(ranks.displayGroupRanks) ?? firstRecord(ranks.classificationRanks)
  if (!preferred) return { salesRank: null, rankCategory: null }
  return {
    salesRank: typeof preferred.rank === 'number' && Number.isFinite(preferred.rank)
      ? preferred.rank
      : null,
    rankCategory: text(preferred.title) ?? text(preferred.websiteDisplayGroup),
  }
}

function mapCatalogItem(value: unknown): CatalogInfo | undefined {
  if (!isRecord(value) || typeof value.asin !== 'string') return undefined
  const summary = firstRecord(value.summaries)
  const browse = summary && isRecord(summary.browseClassification)
    ? summary.browseClassification
    : undefined
  const rank = catalogRank(value)
  return {
    asin: value.asin,
    title: text(summary?.itemName) ?? '',
    brand: text(summary?.brand),
    imageUrl: catalogImage(value),
    category: text(browse?.displayName),
    ...rank,
  }
}

export class LiveCustosClient implements CustosApiClient {
  private readonly endpoint: string
  private readonly tokenManager: LwaTokenManager

  constructor(
    private readonly settings: LiveCustosClientSettings,
    private readonly fetchImpl: Fetch = globalThis.fetch,
    private readonly sleep: Sleep = defaultSleep,
    private readonly pricingIntervalMs = DEFAULT_PRICING_INTERVAL_MS,
    private readonly catalogIntervalMs = DEFAULT_CATALOG_INTERVAL_MS,
    now?: () => number,
  ) {
    this.endpoint = endpointForRegion(settings.region)
    this.tokenManager = new LwaTokenManager({
      clientId: settings.lwaClientId,
      clientSecret: settings.lwaClientSecret,
      refreshToken: settings.refreshToken,
    }, fetchImpl, now)
  }

  async getOffers(asins: string[]): Promise<OfferSnapshot[]> {
    const snapshots = new Map<string, OfferSnapshot>()
    const batches = chunks(asins, MAX_BATCH_SIZE)
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index]
      try {
        const response = await this.request('/batches/products/pricing/v0/itemOffers', {
          method: 'POST',
          body: JSON.stringify({
            requests: batch.map((asin) => ({
              uri: `/products/pricing/v0/items/${encodeURIComponent(asin)}/offers`,
              method: 'GET',
              MarketplaceId: this.settings.marketplaceId,
              ItemCondition: 'New',
            })),
          }),
        })
        const body = await response.json() as Record<string, unknown>
        if (!Array.isArray(body.responses)) throw new Error('SP-API batch response did not contain responses')
        body.responses.forEach((value, itemIndex) => {
          if (!isRecord(value)) return
          const item = value as BatchItemResponse
          const code = statusCode(item)
          if (code !== undefined && (code < 200 || code >= 300)) return
          const payload = payloadFromBatch(item)
          if (!payload) return
          const asin = text(payload.ASIN) ?? requestAsin(item) ?? batch[itemIndex]
          if (asin) snapshots.set(asin, mapOffers(asin, payload))
        })
      } catch {
        // Failed chunks remain absent; later chunks still run.
      }
      if (index < batches.length - 1) await this.sleep(this.pricingIntervalMs)
    }
    return Array.from(snapshots.values())
  }

  async getCatalog(asins: string[]): Promise<CatalogInfo[]> {
    const items = new Map<string, CatalogInfo>()
    const batches = chunks(asins, MAX_BATCH_SIZE)
    for (let index = 0; index < batches.length; index += 1) {
      try {
        const query = new URLSearchParams({
          identifiers: batches[index].join(','),
          identifiersType: 'ASIN',
          marketplaceIds: this.settings.marketplaceId,
          includedData: 'salesRanks,summaries,images',
        })
        const response = await this.request(`/catalog/2022-04-01/items?${query}`, { method: 'GET' })
        const body = await response.json() as Record<string, unknown>
        if (!Array.isArray(body.items)) throw new Error('SP-API catalog response did not contain items')
        for (const value of body.items) {
          const item = mapCatalogItem(value)
          if (item) items.set(item.asin, item)
        }
      } catch {
        // Failed chunks remain absent; later chunks still run.
      }
      if (index < batches.length - 1) await this.sleep(this.catalogIntervalMs)
    }
    return Array.from(items.values())
  }

  async searchByKeywords(query: string, pageToken?: string): Promise<SeedSearchResult> {
    const params = new URLSearchParams({
      keywords: query,
      marketplaceIds: this.settings.marketplaceId,
      includedData: 'salesRanks,summaries,images',
      pageSize: '20',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const response = await this.request(`/catalog/2022-04-01/items?${params}`, { method: 'GET' })
    const body = await response.json() as Record<string, unknown>
    const items = Array.isArray(body.items)
      ? body.items.map(mapCatalogItem).filter((item): item is CatalogInfo => item !== undefined)
      : []
    const pagination = isRecord(body.pagination) ? body.pagination : undefined
    return { items, nextPageToken: text(pagination?.nextToken) }
  }

  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.tokenManager.getAccessToken()
      return { ok: true, detail: 'LWA token OK' }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const token = await this.tokenManager.getAccessToken()
    const requestInit: RequestInit = {
      ...init,
      headers: {
        'x-amz-access-token': token,
        'content-type': 'application/json',
        ...init.headers,
      },
    }
    let response = await this.fetchImpl(`${this.endpoint}${path}`, requestInit)
    if (response.status === 429) {
      await this.sleep(retryDelayMilliseconds(response.headers.get('retry-after')))
      response = await this.fetchImpl(`${this.endpoint}${path}`, requestInit)
    }
    if (!response.ok) throw await responseError(response)
    return response
  }
}

export const LiveCustosApiClient = LiveCustosClient
