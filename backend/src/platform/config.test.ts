import { newId } from '@platform/contract'
import { describe, expect, it } from 'vitest'

import { loadHubConfig } from './config.js'

const VALID_ACCT = newId('acct', 600_000)

describe('loadHubConfig', () => {
  it('returns null with an empty environment — the standalone default', () => {
    expect(loadHubConfig({})).toBeNull()
  })

  it('returns null when only HUB_BASE_URL is set', () => {
    expect(loadHubConfig({ HUB_BASE_URL: 'http://127.0.0.1:4200' })).toBeNull()
  })

  it('returns null when only HISTORY_HUB_TOKEN is set', () => {
    expect(loadHubConfig({ HISTORY_HUB_TOKEN: 'tok' })).toBeNull()
  })

  it('returns null when either value is blank/whitespace', () => {
    expect(loadHubConfig({
      HUB_BASE_URL: '   ',
      HISTORY_HUB_TOKEN: 'tok',
      PLATFORM_ACCOUNT_ID: VALID_ACCT,
    })).toBeNull()
    expect(loadHubConfig({
      HUB_BASE_URL: 'http://hub',
      HISTORY_HUB_TOKEN: '  ',
      PLATFORM_ACCOUNT_ID: VALID_ACCT,
    })).toBeNull()
  })

  it('throws when both URL+token are set but PLATFORM_ACCOUNT_ID is missing', () => {
    expect(() => loadHubConfig({
      HUB_BASE_URL: 'http://127.0.0.1:4200',
      HISTORY_HUB_TOKEN: 'tok',
    })).toThrow(/PLATFORM_ACCOUNT_ID is required/)
  })

  it('throws when PLATFORM_ACCOUNT_ID is not a canonical acct_ ULID', () => {
    expect(() => loadHubConfig({
      HUB_BASE_URL: 'http://127.0.0.1:4200',
      HISTORY_HUB_TOKEN: 'tok',
      PLATFORM_ACCOUNT_ID: 'acct_local_default',
    })).toThrow(/canonical acct_/)
    expect(() => loadHubConfig({
      HUB_BASE_URL: 'http://127.0.0.1:4200',
      HISTORY_HUB_TOKEN: 'tok',
      PLATFORM_ACCOUNT_ID: 'not-an-id',
    })).toThrow(/canonical acct_/)
  })

  it('returns HubConfig when fully configured', () => {
    const config = loadHubConfig({
      HUB_BASE_URL: 'http://127.0.0.1:4200/',
      HISTORY_HUB_TOKEN: 'tok',
      PLATFORM_ACCOUNT_ID: VALID_ACCT,
    })
    expect(config).toEqual({
      baseUrl: 'http://127.0.0.1:4200',
      token: 'tok',
      accountId: VALID_ACCT,
      marketplaceId: 'ATVPDKIKX0DER',
    })
  })

  it('honours PLATFORM_MARKETPLACE_ID when set', () => {
    const config = loadHubConfig({
      HUB_BASE_URL: 'http://hub',
      HISTORY_HUB_TOKEN: 'tok',
      PLATFORM_ACCOUNT_ID: VALID_ACCT,
      PLATFORM_MARKETPLACE_ID: 'A1PA6795UKMFR9',
    })
    expect(config?.marketplaceId).toBe('A1PA6795UKMFR9')
  })
})
