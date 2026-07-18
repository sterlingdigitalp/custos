// Money boundary helpers (PLATFORM-INTEGRATION.md D7).
// Snapshots stay REAL dollars internally. At the platform boundary convert
// each price to integer cents via the contract's rounding, do ALL aggregate
// math in cents, then moneyFromMinor once for emission.

import {
  moneyFromLegacyFloat,
  moneyFromMinor,
  moneyToMinor,
  type Money,
} from '@platform/contract'

const CURRENCY = 'USD'

/**
 * Convert a legacy float dollar amount to integer cents using the contract's
 * half-away-from-zero rounding (via moneyFromLegacyFloat). Null stays null.
 */
export function dollarsToCents(x: number | null): number | null {
  if (x === null) return null
  return Number(moneyToMinor(moneyFromLegacyFloat(x, CURRENCY)))
}

/** Build a Money value from integer cents (minor units). */
export function centsToMoney(cents: number): Money {
  return moneyFromMinor(BigInt(cents), CURRENCY)
}

/** Nullable cents → Money | null. */
export function centsToMoneyOrNull(cents: number | null): Money | null {
  return cents === null ? null : centsToMoney(cents)
}
