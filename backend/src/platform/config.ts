// Hub connection config for Custos-as-history (PLATFORM-INTEGRATION.md D6, D13).
//
// HARD SAFETY RULE: with no Hub env configured, every platform path is a
// complete no-op. loadHubConfig() returns null unless BOTH HUB_BASE_URL and
// HISTORY_HUB_TOKEN are set — a lone URL or lone token is treated as unset.

import { isCanonicalId } from '@platform/contract'

export interface HubConfig {
  baseUrl: string
  token: string
  /** PLATFORM_ACCOUNT_ID — required when Hub is configured (D13). */
  accountId: string
  /** PLATFORM_MARKETPLACE_ID, defaulting to Amazon US (ATVPDKIKX0DER). */
  marketplaceId: string
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

/**
 * Loads Hub config from the environment.
 * Returns null when HUB_BASE_URL or HISTORY_HUB_TOKEN is missing (standalone gate).
 * When both are set, PLATFORM_ACCOUNT_ID is required and must be a canonical acct_ id.
 */
export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig | null {
  const baseUrl = trimmedOrUndefined(env.HUB_BASE_URL)
  const token = trimmedOrUndefined(env.HISTORY_HUB_TOKEN)
  if (!baseUrl || !token) return null

  const accountId = trimmedOrUndefined(env.PLATFORM_ACCOUNT_ID)
  if (!accountId) {
    throw new Error(
      'PLATFORM_ACCOUNT_ID is required when HUB_BASE_URL and HISTORY_HUB_TOKEN are set',
    )
  }
  if (!isCanonicalId(accountId, 'acct')) {
    throw new Error(
      `PLATFORM_ACCOUNT_ID must be a canonical acct_ ULID (got ${JSON.stringify(accountId)})`,
    )
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    token,
    accountId,
    marketplaceId: trimmedOrUndefined(env.PLATFORM_MARKETPLACE_ID) ?? 'ATVPDKIKX0DER',
  }
}
