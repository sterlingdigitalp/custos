import { describe, expect, it } from 'vitest'

import './asin.js'

type CustosGlobal = typeof globalThis & {
  Custos: { extractAsin(url: string): string | null }
}

const { extractAsin } = (globalThis as CustosGlobal).Custos

describe('extractAsin', () => {
  it('extracts 10-character ASINs from supported product URL forms only', () => {
    expect(extractAsin('https://www.amazon.com/dp/B0XXXXXXXX')).toBe('B0XXXXXXXX')
    expect(extractAsin('https://www.amazon.com/gp/product/B0XXXXXXXX')).toBe('B0XXXXXXXX')
    expect(extractAsin('https://www.amazon.com/example-title/-/dp/B0XXXXXXXX')).toBe('B0XXXXXXXX')
    expect(extractAsin('https://www.amazon.com/dp/B0XXXXXXXX?ref_=abc&qid=123')).toBe('B0XXXXXXXX')
    expect(extractAsin('https://www.amazon.com/gp/product/b0xxxxxxxx?tag=test')).toBe('B0XXXXXXXX')
    expect(extractAsin('https://www.amazon.com/s?k=B0XXXXXXXX')).toBeNull()

    // The prompt's illustrative B0XXXXXXXXX value is 11 characters, not a valid ASIN.
    expect(extractAsin('https://www.amazon.com/dp/B0XXXXXXXXX')).toBeNull()
  })
})
