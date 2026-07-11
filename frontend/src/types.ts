export type AlertRuleType = 'price_below' | 'drop_percent' | 'back_in_stock' | 'rank_below' | 'buybox_change'

export interface Snapshot {
  id: number
  asin: string
  ts: string
  buyBoxPrice: number | null
  lowestNewPrice: number | null
  lowestFbaPrice: number | null
  offerCount: number | null
  fbaOfferCount: number | null
  salesRank: number | null
  rankCategory: string | null
}

export interface Product {
  id: number
  asin: string
  title: string | null
  brand: string | null
  imageUrl: string | null
  category: string | null
  rankCategory: string | null
  addedAt: string
  source: string
  isArchived: boolean
  snapshotTs: string | null
  buyBoxPrice: number | null
  lowestNewPrice: number | null
  lowestFbaPrice: number | null
  offerCount: number | null
  fbaOfferCount: number | null
  salesRank: number | null
  latestSnapshot: Snapshot | null
}

export interface Alert {
  id: number
  asin: string
  ruleType: AlertRuleType
  threshold: number | null
  windowHours: number
  isActive: boolean
  cooldownHours: number
  lastFiredAt: string | null
}

export interface AlertEvent {
  id: number
  alertId: number
  asin: string
  ts: string
  message: string
  delivered: boolean
  deliveryError: string | null
  isRead: boolean
}

export interface SweepSummary {
  ts: string
  asins: number
  offersFetched: number
  catalogFetched: number
  bothMissed: number
  fetched: number
  failed: number
  alertsFired: number
}

export interface Status {
  clientMode: 'mock' | 'live'
  client: { ok: boolean; detail: string }
  corpusSize: number
  scheduler: {
    running: boolean
    sweepRunning: boolean
    lastSummary: SweepSummary | null
    lastError: string | null
    nextRunAt: string | null
  }
}

export interface FinderFilters {
  priceMin?: number
  priceMax?: number
  rankMin?: number
  rankMax?: number
  offerCountMax?: number
  priceDropPercent?: number
  priceWindowDays?: number
  rankImprovedPercent?: number
  rankWindowDays?: number
  category?: string
}

export interface FinderResult extends Product {
  ts: string
  currentPrice: number | null
  priceDropPercent: number | null
  rankImprovedPercent: number | null
}

export interface SeedCandidate {
  asin: string
  title: string
  brand: string | null
  imageUrl: string | null
  category: string | null
  salesRank: number | null
  rankCategory: string | null
  isTracked: boolean
  price?: number | null
}

export interface SeedSearchResult { items: SeedCandidate[]; nextPageToken: string | null }
export interface SeedQuery { id: number; query: string; addedAt: string; lastRunAt: string | null }

export interface SellerampImportPreview {
  newCount: number
  alreadyPresent: number
  skippedInvalid: number
  sampleNew: Array<{ asin: string; name: string }>
}

export interface SellerampImportSummary {
  imported: number
  updatedMetadata: number
  skippedInvalid: number
  alreadyPresent: number
  totalTracked: number
  warning?: string
}

export interface Settings {
  id: 1
  lwaClientId: string | null
  lwaClientSecret: string | null
  refreshToken: string | null
  marketplaceId: string
  region: string
  sweepIntervalMin: number
  ntfyTopic: string | null
  ntfyServer: string
}
