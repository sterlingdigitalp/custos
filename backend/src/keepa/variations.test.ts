import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProduct } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import {
  INTERESTING_SIZES_M,
  INTERESTING_SIZES_W,
  detectGenderFromCategoryTree,
  detectGenderFromTitle,
  mineVariationCandidates,
  normalizeSize,
  validateGenderSignals,
} from './variations.js'

function variation(asin: string, size: string): Record<string, unknown> {
  return { asin, attributes: [{ dimension: 'Size', value: size }] }
}

function categoryTree(...names: string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }))
}

function insertRaw(
  db: DatabaseHandle,
  asin: string,
  opts: {
    title?: string | null
    categoryTree?: unknown
    variations?: Array<Record<string, unknown>>
  } = {},
): void {
  const product = {
    asin,
    title: opts.title ?? null,
    categoryTree: opts.categoryTree ?? null,
    variations: opts.variations ?? [],
    csv: new Array(36).fill(null),
  }
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

describe('detectGenderFromCategoryTree', () => {
  it('classifies a Men node as M', () => {
    expect(
      detectGenderFromCategoryTree(
        categoryTree('Clothing, Shoes & Jewelry', 'Men', 'Shoes', 'Athletic', 'Running', 'Road Running'),
      ),
    ).toBe('M')
  })

  it('classifies a Women node as W', () => {
    expect(
      detectGenderFromCategoryTree(categoryTree('Clothing, Shoes & Jewelry', 'Women', 'Shoes')),
    ).toBe('W')
  })

  it('classifies a Girls node as W and a Boys node as M', () => {
    expect(detectGenderFromCategoryTree(categoryTree('Clothing, Shoes & Jewelry', 'Girls', 'Shoes'))).toBe('W')
    expect(detectGenderFromCategoryTree(categoryTree('Clothing, Shoes & Jewelry', 'Boys', 'Shoes'))).toBe('M')
  })

  it('never classifies a tree containing Women as M, even if a Men node is also present', () => {
    expect(
      detectGenderFromCategoryTree(
        categoryTree('Clothing, Shoes & Jewelry', 'Novelty', 'Men', 'Women', 'Costumes'),
      ),
    ).toBe('W')
  })

  it('returns null for a tree with no gender node', () => {
    expect(detectGenderFromCategoryTree(categoryTree('Clothing, Shoes & Jewelry', 'Shoes', 'Athletic'))).toBeNull()
  })

  it('returns null for non-array input', () => {
    expect(detectGenderFromCategoryTree(null)).toBeNull()
    expect(detectGenderFromCategoryTree(undefined)).toBeNull()
    expect(detectGenderFromCategoryTree('Men')).toBeNull()
    expect(detectGenderFromCategoryTree({ name: 'Men' })).toBeNull()
  })
})

describe('validateGenderSignals', () => {
  let db: DatabaseHandle
  beforeEach(() => { db = openDatabase(':memory:') })
  afterEach(() => db.close())

  it('reports coverage and agreement between categoryTree and title', () => {
    const oneSibling = [variation('B0SIB0000001', '10')]

    // 3 families where both signals agree.
    insertRaw(db, 'B0AGREE0001', {
      title: 'Nike Mens Runner', categoryTree: categoryTree('Men'), variations: oneSibling,
    })
    insertRaw(db, 'B0AGREE0002', {
      title: 'Nike Womens Runner', categoryTree: categoryTree('Women'), variations: oneSibling,
    })
    insertRaw(db, 'B0AGREE0003', {
      title: 'Nike Mens Runner 2', categoryTree: categoryTree('Men'), variations: oneSibling,
    })

    // 1 family where the signals disagree.
    insertRaw(db, 'B0DISAGREE1', {
      title: 'Nike Mens Runner', categoryTree: categoryTree('Women'), variations: oneSibling,
    })

    // 2 categoryTree-only families.
    insertRaw(db, 'B0CATONLY01', {
      title: 'Air Max 90', categoryTree: categoryTree('Men'), variations: oneSibling,
    })
    insertRaw(db, 'B0CATONLY02', {
      title: 'Air Max 91', categoryTree: categoryTree('Women'), variations: oneSibling,
    })

    // 2 title-only families.
    insertRaw(db, 'B0TITONLY01', {
      title: 'Nike Womens Runner', categoryTree: null, variations: oneSibling,
    })
    insertRaw(db, 'B0TITONLY02', {
      title: 'Nike Mens Runner', categoryTree: categoryTree('Shoes'), variations: oneSibling,
    })

    // 1 family with neither signal.
    insertRaw(db, 'B0NEITHER01', {
      title: 'Classic Runner', categoryTree: categoryTree('Shoes'), variations: oneSibling,
    })

    const result = validateGenderSignals(db)
    expect(result.familiesWithBoth).toBe(4)
    expect(result.agreement).toBe(3)
    expect(result.agreementRate).toBeCloseTo(0.75, 5)
    expect(result.categoryOnly).toBe(2)
    expect(result.titleOnly).toBe(2)
    expect(result.neither).toBe(1)
  })

  it('ignores families with no usable sibling sizes', () => {
    insertRaw(db, 'B0EMPTYFAM1', { title: 'Nike Mens Runner', categoryTree: categoryTree('Men'), variations: [] })
    const result = validateGenderSignals(db)
    expect(result.familiesWithBoth + result.categoryOnly + result.titleOnly + result.neither).toBe(0)
  })
})

describe('mineVariationCandidates', () => {
  let db: DatabaseHandle
  beforeEach(() => { db = openDatabase(':memory:') })
  afterEach(() => db.close())

  it('mines interesting-size siblings using categoryTree-first gender resolution, excludes tracked/harvested, dedupes', () => {
    // F1: categoryTree AND title agree (Men) — categoryTree wins the
    // resolution race, so this counts as genderFromCategory not genderFromTitle.
    insertRaw(db, 'B0MPARENT1', {
      title: 'Nike Downshifter 12 Mens',
      categoryTree: categoryTree('Clothing, Shoes & Jewelry', 'Men', 'Shoes'),
      variations: [
        variation('B0MPARENT1', '12'), // self-reference — excluded
        variation('B0MSIB0009', '9'), // not interesting
        variation('B0MSIB0095', '9.5'), // interesting, new
        variation('B0MSIB0100', '10'), // interesting, ALREADY TRACKED
        variation('B0MSIB0105', '10.5'), // interesting, new
        variation('B0MSIB0110', '11'), // interesting, ALREADY HARVESTED
        variation('B0MSIB0120', '12'), // interesting, new
        variation('B0MSIB0130', '13'), // not interesting
      ],
    })

    // F2: no categoryTree, title-only resolution (Women).
    insertRaw(db, 'B0WPARENT1', {
      title: "NIKE W Free Metcon 5, Women's Sneaker",
      categoryTree: null,
      variations: [
        variation('B0WSIB0007', '7'), // not interesting
        variation('B0WSIB0075', '7.5'), // interesting, new
        variation('B0WSIB0080', '8'), // interesting, new
        variation('B0WSIB0085', '8.5'), // interesting, new
        variation('B0WSIB0090', '9'), // interesting, new
        variation('B0WSIB0100', '10'), // not interesting for W
      ],
    })

    // F5: no usable siblings — scanned but not a "family with sizes".
    insertRaw(db, 'B0NOVARIAT', { title: 'Something Else', categoryTree: null, variations: [] })

    // F_dup: categoryTree-only (no title), resolves Men. Includes a
    // duplicate of F1's B0MSIB0095 candidate (dedupe test) plus one new ASIN.
    insertRaw(db, 'B0DUPPARENT', {
      title: null,
      categoryTree: categoryTree('Men'),
      variations: [
        variation('B0MSIB0095', '9.5'), // dup of F1's candidate
        variation('B0DUPSIB012', '12'), // interesting, new
      ],
    })

    // Already-tracked / already-harvested exclusions.
    createProduct(db, { asin: 'B0MSIB0100', source: 'manual' })
    db.prepare(`
      INSERT INTO keepa_checkpoint (asin, status, tokens_spent, last_error, updated_at)
      VALUES ('B0MSIB0110', 'done', 1, NULL, '2026-01-01T00:00:00.000Z')
    `).run()

    const { candidates, stats } = mineVariationCandidates(db)

    expect(stats.payloadsScanned).toBe(4)
    expect(stats.familiesWithSizes).toBe(3) // F1, F2, F_dup (F5 excluded)
    expect(stats.genderFromCategory).toBe(2) // F1, F_dup
    expect(stats.genderFromTitle).toBe(1) // F2
    expect(stats.genderUnresolvedSkipped).toBe(0)
    expect(stats.siblingsSeen).toBe(7 + 6 + 2)
    expect(stats.sizeFiltered).toBe(2 + 2 + 0)
    expect(stats.alreadyTracked).toBe(1)
    expect(stats.alreadyHarvested).toBe(1)
    expect(stats.candidates).toBe(8)

    expect(candidates).toEqual([...candidates].sort())
    expect(candidates).toEqual([
      'B0DUPSIB012',
      'B0MSIB0095',
      'B0MSIB0105',
      'B0MSIB0120',
      'B0WSIB0075',
      'B0WSIB0080',
      'B0WSIB0085',
      'B0WSIB0090',
    ])
    // Dedupe: B0MSIB0095 appears in both F1 and F_dup but only once in the output.
    expect(candidates.filter((asin) => asin === 'B0MSIB0095')).toHaveLength(1)
    // Excluded ASINs never appear.
    expect(candidates).not.toContain('B0MSIB0100')
    expect(candidates).not.toContain('B0MSIB0110')
    expect(candidates).not.toContain('B0MPARENT1')
  })

  it('resolves gender from categoryTree even when the title disagrees (categoryTree wins)', () => {
    insertRaw(db, 'B0CONFLICT1', {
      title: 'Reebok Mens Runner', // title says M
      categoryTree: categoryTree('Clothing, Shoes & Jewelry', 'Women', 'Shoes'), // categoryTree says W
      variations: [
        variation('B0CFSIB0080', '8'), // interesting for W
        variation('B0CFSIB0085', '8.5'), // interesting for W
        variation('B0CFSIB0100', '10'), // interesting for M only — must be filtered since W won
      ],
    })

    const { candidates, stats } = mineVariationCandidates(db)

    expect(stats.genderFromCategory).toBe(1)
    expect(stats.genderFromTitle).toBe(0)
    expect(stats.sizeFiltered).toBe(1) // the size-10 sibling, filtered against the W set
    expect(candidates.sort()).toEqual(['B0CFSIB0080', 'B0CFSIB0085'])
    expect(candidates).not.toContain('B0CFSIB0100')
  })

  it('skips a family with neither categoryTree nor title gender signal', () => {
    insertRaw(db, 'B0NEITHER01', {
      title: 'Classic Runner',
      categoryTree: categoryTree('Clothing, Shoes & Jewelry', 'Shoes'),
      variations: [variation('B0ZSIB0011', '11')],
    })

    const { candidates, stats } = mineVariationCandidates(db)

    expect(stats.familiesWithSizes).toBe(1)
    expect(stats.genderFromCategory).toBe(0)
    expect(stats.genderFromTitle).toBe(0)
    expect(stats.genderUnresolvedSkipped).toBe(1)
    expect(stats.siblingsSeen).toBe(0)
    expect(candidates).toEqual([])
  })

  it('exports the interesting-size constants used for filtering', () => {
    expect([...INTERESTING_SIZES_M]).toEqual(['9.5', '10', '10.5', '11', '12'])
    expect([...INTERESTING_SIZES_W]).toEqual(['7.5', '8', '8.5', '9'])
  })
})
