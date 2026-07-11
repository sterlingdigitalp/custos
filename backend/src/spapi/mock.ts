import type {
  CatalogInfo,
  CustosApiClient,
  OfferSnapshot,
  SeedSearchResult,
} from './client.js'

export interface MockProductFixture {
  basePrice: number
  rank: number
  offers: number
  fba: number
  title?: string
  brand?: string | null
  imageUrl?: string | null
  category?: string | null
  rankCategory?: string | null
  outOfStockEveryFifth?: boolean
  steadilyImprovingRank?: boolean
}

export type MockProductFixtures = Record<string, MockProductFixture>

function cloneFixtures(fixtures: MockProductFixtures): MockProductFixtures {
  return Object.fromEntries(
    Object.entries(fixtures).map(([asin, fixture]) => [asin, { ...fixture }]),
  )
}

function asinSeed(asin: string): number {
  let seed = 0
  for (const character of asin) {
    seed = (seed * 31 + character.charCodeAt(0)) % 10_000
  }
  return seed
}

function wave(asin: string, tick: number, salt = 0): number {
  const seed = asinSeed(asin)
  return Math.sin(seed * 0.017 + tick * 0.83 + salt) * 0.7 +
    Math.sin(seed * 0.007 + tick * 0.29 + salt * 2) * 0.3
}

function money(value: number): number {
  return Math.round(Math.max(0.01, value) * 100) / 100
}

export class MockCustosApiClient implements CustosApiClient {
  private readonly fixtures: MockProductFixtures
  private tick = 0

  constructor(fixtures: MockProductFixtures) {
    this.fixtures = cloneFixtures(fixtures)
  }

  async getOffers(asins: string[]): Promise<OfferSnapshot[]> {
    const tick = ++this.tick
    const results: OfferSnapshot[] = []
    for (const asin of asins) {
      const fixture = this.fixtures[asin]
      if (!fixture) {
        continue
      }
      const outOfStock = fixture.outOfStockEveryFifth === true && tick % 5 === 0
      if (outOfStock) {
        results.push({
          asin,
          buyBoxPrice: null,
          lowestNewPrice: null,
          lowestFbaPrice: null,
          offerCount: 0,
          fbaOfferCount: 0,
        })
        continue
      }

      const buyBoxPrice = money(fixture.basePrice + wave(asin, tick) * 1.35)
      const offerDelta = Math.round(wave(asin, tick, 1.4) * 2)
      const offerCount = Math.max(1, fixture.offers + offerDelta)
      const fbaOfferCount = Math.min(
        offerCount,
        Math.max(0, fixture.fba + Math.round(wave(asin, tick, 2.1))),
      )
      results.push({
        asin,
        buyBoxPrice,
        lowestNewPrice: money(buyBoxPrice - 0.15 + wave(asin, tick, 0.4) * 0.25),
        lowestFbaPrice: fbaOfferCount > 0
          ? money(buyBoxPrice + 0.2 + wave(asin, tick, 0.8) * 0.3)
          : null,
        offerCount,
        fbaOfferCount,
      })
    }
    return results
  }

  async getCatalog(asins: string[]): Promise<CatalogInfo[]> {
    const tick = ++this.tick
    const results: CatalogInfo[] = []
    for (const asin of asins) {
      const fixture = this.fixtures[asin]
      if (!fixture) {
        continue
      }
      const salesRank = fixture.steadilyImprovingRank
        ? Math.max(1, fixture.rank - tick * 137)
        : Math.max(1, Math.round(fixture.rank + wave(asin, tick, 3.2) * fixture.rank * 0.04))
      results.push({
        asin,
        title: fixture.title ?? `Mock product ${asin}`,
        brand: fixture.brand ?? 'Custos Mock',
        imageUrl: fixture.imageUrl ?? `https://example.test/images/${asin}.jpg`,
        category: fixture.category ?? 'Home & Kitchen',
        salesRank,
        rankCategory: fixture.rankCategory ?? 'Home & Kitchen',
      })
    }
    return results
  }

  async searchByKeywords(query: string, _pageToken?: string): Promise<SeedSearchResult> {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) {
      return { items: [], nextPageToken: null }
    }
    const matchingAsins = Object.entries(this.fixtures)
      .filter(([asin, fixture]) => [
        asin,
        fixture.title ?? '',
        fixture.brand ?? '',
        fixture.category ?? '',
      ].some((value) => value.toLocaleLowerCase().includes(needle)))
      .map(([asin]) => asin)
    const items = await this.getCatalog(matchingAsins)
    return { items, nextPageToken: null }
  }

  async ping(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'deterministic mock Custos SP-API client' }
  }
}

export function defaultFixtures(): MockProductFixtures {
  return {
    B0CUSTOS01: {
      basePrice: 24.99,
      rank: 12_500,
      offers: 8,
      fba: 5,
      title: 'Bamboo Drawer Organizer',
      brand: 'Northstar Home',
      category: 'Home & Kitchen',
    },
    B0CUSTOS02: {
      basePrice: 11.49,
      rank: 48_000,
      offers: 3,
      fba: 1,
      title: 'USB-C Braided Cable',
      brand: 'Wireworks',
      category: 'Electronics',
    },
    B0CUSTOS03: {
      basePrice: 39.95,
      rank: 7_800,
      offers: 12,
      fba: 9,
      title: 'Insulated Water Bottle',
      brand: 'Ridgeline',
      category: 'Sports & Outdoors',
    },
    B0CUSTOS04: {
      basePrice: 17.25,
      rank: 83_000,
      offers: 2,
      fba: 2,
      title: 'Silicone Baking Mat Pair',
      brand: 'Ovenbird',
      category: 'Kitchen & Dining',
      outOfStockEveryFifth: true,
    },
    B0CUSTOS05: {
      basePrice: 64.99,
      rank: 35_000,
      offers: 6,
      fba: 4,
      title: 'Mechanical Keyboard',
      brand: 'Keystone',
      category: 'Computers',
    },
    B0CUSTOS06: {
      basePrice: 8.75,
      rank: 120_000,
      offers: 15,
      fba: 7,
      title: 'Microfiber Cleaning Cloths',
      brand: 'Brightwork',
      category: 'Health & Household',
    },
    B0CUSTOS07: {
      basePrice: 29.5,
      rank: 55_000,
      offers: 5,
      fba: 3,
      title: 'LED Desk Lamp',
      brand: 'Lucent',
      category: 'Office Products',
      steadilyImprovingRank: true,
    },
    B0CUSTOS08: {
      basePrice: 14.2,
      rank: 22_000,
      offers: 9,
      fba: 6,
      title: 'Pet Grooming Brush',
      brand: 'Companion Co',
      category: 'Pet Supplies',
    },
  }
}

export const MockSpApiClient = MockCustosApiClient
