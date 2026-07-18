import { describe, expect, it } from 'vitest'

import { centsToMoney, centsToMoneyOrNull, dollarsToCents } from './money.js'

describe('platform money boundary (D7)', () => {
  it('dollarsToCents null-passes', () => {
    expect(dollarsToCents(null)).toBeNull()
  })

  it('converts clean dollars via contract half-away-from-zero', () => {
    expect(dollarsToCents(19.99)).toBe(1999)
    expect(dollarsToCents(0)).toBe(0)
    expect(dollarsToCents(1)).toBe(100)
  })

  it('rounds half away from zero (no banker’s rounding)', () => {
    // 10.005 → 1000.5 cents → 1001 (away from zero)
    expect(dollarsToCents(10.005)).toBe(1001)
    expect(dollarsToCents(-10.005)).toBe(-1001)
  })

  it('centsToMoney builds contract Money strings', () => {
    expect(centsToMoney(1999)).toEqual({ amount: '19.99', currency: 'USD' })
    expect(centsToMoney(0)).toEqual({ amount: '0.00', currency: 'USD' })
    expect(centsToMoneyOrNull(null)).toBeNull()
    expect(centsToMoneyOrNull(50)).toEqual({ amount: '0.50', currency: 'USD' })
  })
})
