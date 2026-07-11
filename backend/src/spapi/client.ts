import type { Settings } from '../db/repo.js'
import { LiveCustosClient } from './live.js'
import { defaultFixtures, MockCustosApiClient } from './mock.js'

export interface OfferSnapshot {
  asin: string
  buyBoxPrice: number | null
  lowestNewPrice: number | null
  lowestFbaPrice: number | null
  offerCount: number
  fbaOfferCount: number
}

export interface CatalogInfo {
  asin: string
  title: string
  brand: string | null
  imageUrl: string | null
  category: string | null
  salesRank: number | null
  rankCategory: string | null
}

export interface SeedSearchResult {
  items: CatalogInfo[]
  nextPageToken: string | null
}

export interface CustosApiClient {
  getOffers(asins: string[]): Promise<OfferSnapshot[]>
  getCatalog(asins: string[]): Promise<CatalogInfo[]>
  searchByKeywords(query: string, pageToken?: string): Promise<SeedSearchResult>
  ping(): Promise<{ ok: boolean; detail: string }>
}

type ClientSettings = Pick<Settings, 'lwaClientId' | 'lwaClientSecret' | 'refreshToken'> &
  Partial<Pick<Settings, 'marketplaceId' | 'region'>>

export function createCustosClient(settings: ClientSettings): CustosApiClient {
  if (!settings.lwaClientId || !settings.lwaClientSecret || !settings.refreshToken) {
    return new MockCustosApiClient(defaultFixtures())
  }
  return new LiveCustosClient({
    lwaClientId: settings.lwaClientId,
    lwaClientSecret: settings.lwaClientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId ?? 'ATVPDKIKX0DER',
    region: settings.region ?? 'na',
  })
}
