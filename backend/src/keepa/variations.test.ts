import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProduct } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import {
  INTERESTING_SIZES_M,
  INTERESTING_SIZES_W,
  detectGenderFromTitle,
  inferGenderFromSizes,
  mineVariationCandidates,
  normalizeSize,
  validateGenderInference,
} from './variations.js'

function variation(asin: string, size: string): Record<string, unknown> {
  return { asin, attributes: [{ dimension: 'Size', value: size }] }
}

function insertRaw(
  db: DatabaseHandle,
  asin: string,
  title: string | null,
  variations: Array<Record<string, unknown>>,
): void {
  const product = { asin, title, variations, csv: new Array(36).fill(null) }
  const payload = gzipSync(Buffer.from(JSON.stringify(product), 'utf8'))
  db.prepare(`
    INSERT INTO keepa_raw (asin, domain, fetched_at, tokens_cost, payload)
    VALUES (@asin, 1, '2026-01-01T00:00:00.000Z', 1, @payload)
  `).run({ asin, payload })
}

describe('normalizeSize', () => {
  it.each([
    ['10', '10'],
    ['10.0', '10'],
    ['10.5 Wide', '10.5'],
    ['10 M US', '10'],
    ['9.5', '9.5'],
    ['10.5M', '10.5'],
  ])('normalizes %s -> %s', (raw, expected) => {
    expect(normalizeSize(raw)).toBe(expected)
  })

  it.each(['XL', 'One Size', '10.25', ''])('rejects %s', (raw) => {
    expect(normalizeSize(raw)).toBeNull()
  })
})

describe('detectGenderFromTitle', () => {
  it('classifies women titles as W', () => {
    expect(detectGenderFromTitle('Nike Womens Flex Experience')).toBe('W')
    expect(detectGenderFromTitle("NIKE W Free Metcon 5, Women's Sneaker")).toBe('W')
  })

  it('classifies men titles as M', () => {
    expect(detectGenderFromTitle('Nike Downshifter 12 Mens')).toBe('M')
  })

  it('never classifies a title containing "Women" as M (women tested first)', () => {
    const titles = [
      'Nike Womens Flex Experience',
      "NIKE W Free Metcon 5, Women's Sneaker",
      'Adidas Woman Running Shoe',
      "Women's Ultraboost 22 Running Shoe for Men and Women",
    ]
    for (const title of titles) {
      expect(detectGenderFromTitle(title)).toBe('W')
    }
  })

  it('returns null when neither signal is present', () => {
    expect(detectGenderFromTitle('Air Max 90')).toBeNull()
    expect(detectGenderFromTitle(null)).toBeNull()
  })
})

describe('inferGenderFromSizes', () => {
  it('infers M when max size >= 12.5', () => {
    expect(inferGenderFromSizes([9.5, 12, 13])).toBe('M')
  })

  it('infers W when max size <= 10.5', () => {
    expect(inferGenderFromSizes([7, 8, 10.5])).toBe('W')
  })

  it('is ambiguous (null) between the thresholds', () => {
    expect(inferGenderFromSizes([11])).toBeNull()
  })

  it('is ambiguous (null) with no sizes', () => {
    expect(inferGenderFromSizes([])).toBeNull()
  })
})

describe('validateGenderInference', () => {
  let db: DatabaseHandle
  beforeEach(() => { db = openDatabase(':memory:') })
  afterEach(() => db.close())

  it('measures >= 0.85 accuracy against known-gender families', () => {
    // 8 men families the size rule gets right (max size >= 12.5).
    for (let i = 0; i < 8; i += 1) {
      insertRaw(db, `B0MENOK${String(i).padStart(3, '0')}`, 'Nike Air Mens Runner', [
        variation(`B0MENOKA${i}`, '9'),
        variation(`B0MENOKB${i}`, String(12.5 + i * 0.5)),
      ])
    }
    // 8 women families the size rule gets right (max size <= 10.5).
    for (let i = 0; i < 8; i += 1) {
      insertRaw(db, `B0WOMOK${String(i).padStart(3, '0')}`, 'Nike Air Womens Runner', [
        variation(`B0WOMOKA${i}`, '6'),
        variation(`B0WOMOKB${i}`, String(7 + i * 0.5)),
      ])
    }
    // 2 men families the size rule gets WRONG (narrow-max, reads as W).
    for (let i = 0; i < 2; i += 1) {
      insertRaw(db, `B0MENBAD${String(i).padStart(3, '0')}`, 'Nike Air Mens Narrow', [
        variation(`B0MENBADA${i}`, '8'),
        variation(`B0MENBADB${i}`, '10'),
      ])
    }

    const result = validateGenderInference(db)
    expect(result.totalKnown).toBe(18)
    expect(result.applicable).toBe(18)
    expect(result.correct).toBe(16)
    expect(result.accuracy).toBeCloseTo(16 / 18, 5)
    expect(result.accuracy).toBeGreaterThanOrEqual(0.85)
  })
})

describe('mineVariationCandidates', () => {
  let db: DatabaseHandle
  beforeEach(() => { db = openDatabase(':memory:') })
  afterEach(() => db.close())

  it('mines interesting-size siblings, infers ambiguous-title gender, excludes tracked/harvested, dedupes', () => {
    // P1: men's family (title-determined gender).
    insertRaw(db, 'B0MPARENT1', 'Nike Downshifter 12 Mens', [
      variation('B0MPARENT1', '12'), // self-reference — excluded
      variation('B0MSIB0009', '9'), // not interesting
      variation('B0MSIB0095', '9.5'), // interesting, new
      variation('B0MSIB0100', '10'), // interesting, ALREADY TRACKED
      variation('B0MSIB0105', '10.5'), // interesting, new
      variation('B0MSIB0110', '11'), // interesting, ALREADY HARVESTED
      variation('B0MSIB0120', '12'), // interesting, new
      variation('B0MSIB0130', '13'), // not interesting
    ])

    // P2: women's family (title-determined gender).
    insertRaw(db, 'B0WPARENT1', "NIKE W Free Metcon 5, Women's Sneaker", [
      variation('B0WSIB0007', '7'), // not interesting
      variation('B0WSIB0075', '7.5'), // interesting, new
      variation('B0WSIB0080', '8'), // interesting, new
      variation('B0WSIB0085', '8.5'), // interesting, new
      variation('B0WSIB0090', '9'), // interesting, new
      variation('B0WSIB0100', '10'), // not interesting for W
    ])

    // P3: ambiguous title, gender INFERRED as M (max size 13 >= 12.5).
    // Includes a duplicate of P1's B0MSIB0095 candidate (dedupe test).
    insertRaw(db, 'B0AMBGINFR', 'Air Max 90', [
      variation('B0MSIB0095', '9.5'), // interesting for M, dup of P1's candidate
      variation('B0AISIB0012', '12'), // interesting for M, new
      variation('B0AISIB0130', '13'), // not interesting for M
    ])

    // P4: ambiguous title, gender inference also ambiguous (max size 11) — skipped entirely.
    insertRaw(db, 'B0AMBGSKIP', 'Classic Runner', [
      variation('B0ZSIB0011', '11'),
    ])

    // P5: no usable siblings (empty variations) — scanned but not a "family with sizes".
    insertRaw(db, 'B0NOVARIAT', 'Something Else', [])

    // Already-tracked / already-harvested exclusions.
    createProduct(db, { asin: 'B0MSIB0100', source: 'manual' })
    db.prepare(`
      INSERT INTO keepa_checkpoint (asin, status, tokens_spent, last_error, updated_at)
      VALUES ('B0MSIB0110', 'done', 1, NULL, '2026-01-01T00:00:00.000Z')
    `).run()

    const { candidates, stats } = mineVariationCandidates(db)

    expect(stats.payloadsScanned).toBe(5)
    expect(stats.familiesWithSizes).toBe(4)
    expect(stats.genderFromTitle).toBe(2)
    expect(stats.genderInferred).toBe(1)
    expect(stats.genderAmbiguousSkipped).toBe(1)
    expect(stats.siblingsSeen).toBe(7 + 6 + 3)
    expect(stats.sizeFiltered).toBe(2 + 2 + 1)
    expect(stats.alreadyTracked).toBe(1)
    expect(stats.alreadyHarvested).toBe(1)
    expect(stats.candidates).toBe(8)

    expect(candidates).toEqual([...candidates].sort())
    expect(candidates).toEqual([
      'B0AISIB0012',
      'B0MSIB0095',
      'B0MSIB0105',
      'B0MSIB0120',
      'B0WSIB0075',
      'B0WSIB0080',
      'B0WSIB0085',
      'B0WSIB0090',
    ])
    // Dedupe: B0MSIB0095 appears in both P1 and P3 but only once in the output.
    expect(candidates.filter((asin) => asin === 'B0MSIB0095')).toHaveLength(1)
    // Excluded ASINs never appear.
    expect(candidates).not.toContain('B0MSIB0100')
    expect(candidates).not.toContain('B0MSIB0110')
    expect(candidates).not.toContain('B0MPARENT1')
  })

  it('exports the interesting-size constants used for filtering', () => {
    expect([...INTERESTING_SIZES_M]).toEqual(['9.5', '10', '10.5', '11', '12'])
    expect([...INTERESTING_SIZES_W]).toEqual(['7.5', '8', '8.5', '9'])
  })
})
