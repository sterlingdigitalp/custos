// Mines Keepa variation siblings (shoe-corpus expansion candidates).
//
// Every keepa_raw payload is a Keepa product with (sometimes) a
// `variations` array listing sibling ASINs of the same style in other
// sizes/colors. We want the "interesting" untracked sizes — the ones a
// reseller is most likely to be able to find/flip — for products whose
// gender we can determine, from Amazon's own categoryTree first (it's a
// classification, not a string guess) and the title as a fallback.
//
// A size-based gender inference (max sibling size >= threshold -> M, etc.)
// was tried and measured at 74.8% accuracy against the real 3,416-payload
// corpus — worse than just skipping the family — and was removed in favor
// of categoryTree (93.9% coverage on its own, 95.4% agreement with title
// where both exist). See validateGenderSignals() for the live health check.
//
// See KEEPA-BACKFILL.md K1 for keepa_raw/keepa_checkpoint shape.

import { gunzipSync } from 'node:zlib'

import type { DatabaseHandle } from '../db/schema.js'

export type Gender = 'M' | 'W'

/** Sizes worth harvesting once a family's gender is known. Easy to tune. */
export const INTERESTING_SIZES_M: ReadonlySet<string> = new Set([
  '9.5', '10', '10.5', '11', '12',
])
export const INTERESTING_SIZES_W: ReadonlySet<string> = new Set([
  '7.5', '8', '8.5', '9',
])

export interface MineVariationCandidatesOptions {
  log?: (message: string) => void
}

export interface MineVariationCandidatesStats {
  payloadsScanned: number
  familiesWithSizes: number
  genderFromCategory: number
  genderFromTitle: number
  genderUnresolvedSkipped: number
  siblingsSeen: number
  sizeFiltered: number
  alreadyTracked: number
  alreadyHarvested: number
  candidates: number
}

export interface MineVariationCandidatesResult {
  candidates: string[]
  stats: MineVariationCandidatesStats
}

export interface GenderSignalValidation {
  /** Families where BOTH categoryTree and title yielded a gender. */
  familiesWithBoth: number
  /** Of those, how many agreed. */
  agreement: number
  /** agreement / familiesWithBoth (0 when familiesWithBoth is 0). */
  agreementRate: number
  /** categoryTree yielded a gender but the title did not. */
  categoryOnly: number
  /** Title yielded a gender but categoryTree did not. */
  titleOnly: number
  /** Neither signal yielded a gender. */
  neither: number
}

interface SiblingSize {
  asin: string
  /** Canonical normalized size string, e.g. "10.5". */
  size: string
}

interface FamilyInfo {
  asin: string
  title: string | null
  categoryTree: unknown
  siblingSizes: SiblingSize[]
}

interface KeepaRawRow {
  asin: string
  payload: Buffer
}

/**
 * Normalize a Keepa "Size" attribute value to a canonical string, or null
 * if it doesn't parse to a whole or half (X / X.5) shoe size.
 * "10 M US" -> "10", "10.5 Wide" -> "10.5", "10.5M" -> "10.5",
 * "10.0" -> "10", "XL"/"One Size"/"10.25"/"" -> null.
 */
export function normalizeSize(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)/)
  if (!match) return null
  const value = parseFloat(match[1]!)
  if (!Number.isFinite(value)) return null
  const doubled = value * 2
  if (Math.abs(doubled - Math.round(doubled)) > 1e-9) return null
  return String(value)
}

/**
 * Detect family gender from a product title. Tests WOMEN first — "men" is
 * a substring of "women", so testing "men" first would misclassify every
 * women's title.
 */
export function detectGenderFromTitle(title: string | null | undefined): Gender | null {
  if (!title) return null
  if (/wom[ae]n|ladies|\bw\b/i.test(title)) return 'W'
  if (/\bmens?\b|\bmen's\b|\bm\b|male/i.test(title)) return 'M'
  return null
}

/**
 * Detect family gender from a Keepa `categoryTree` (array of {name} nodes,
 * root-to-leaf, e.g. ["Clothing, Shoes & Jewelry","Men","Shoes","Athletic",
 * "Running","Road Running"]). Amazon's own classification — authoritative,
 * and covers more families than the title. Tests WOMEN/GIRLS across all
 * nodes before MEN/BOYS (same substring hazard as titles, even though the
 * ^-anchored patterns make it mostly moot for this field).
 */
export function detectGenderFromCategoryTree(categoryTree: unknown): Gender | null {
  if (!Array.isArray(categoryTree)) return null

  const names: string[] = []
  for (const node of categoryTree) {
    if (node && typeof node === 'object') {
      const name = (node as Record<string, unknown>).name
      if (typeof name === 'string') names.push(name.trim())
    }
  }

  for (const name of names) {
    if (/^wom[ae]n/i.test(name) || /^girls?$/i.test(name)) return 'W'
  }
  for (const name of names) {
    if (/^men/i.test(name) || /^boys?$/i.test(name)) return 'M'
  }
  return null
}

function decodeProduct(payload: Buffer): Record<string, unknown> | null {
  try {
    return JSON.parse(gunzipSync(payload).toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Extract {asin, title, siblingSizes} from a raw Keepa product object. */
function extractFamily(product: Record<string, unknown>): FamilyInfo | null {
  const asin = typeof product.asin === 'string' ? product.asin.trim().toUpperCase() : ''
  if (!asin) return null

  const title = typeof product.title === 'string' ? product.title : null
  const variations = Array.isArray(product.variations) ? product.variations : []

  const siblingSizes: SiblingSize[] = []
  for (const entry of variations) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const siblingAsin = typeof record.asin === 'string' ? record.asin.trim().toUpperCase() : ''
    if (!siblingAsin || siblingAsin === asin) continue

    const attributes = Array.isArray(record.attributes) ? record.attributes : []
    let rawSize: string | undefined
    for (const attr of attributes) {
      if (!attr || typeof attr !== 'object') continue
      const attrRecord = attr as Record<string, unknown>
      if (
        typeof attrRecord.dimension === 'string' &&
        attrRecord.dimension.toLowerCase() === 'size' &&
        typeof attrRecord.value === 'string'
      ) {
        rawSize = attrRecord.value
        break
      }
    }
    if (rawSize === undefined) continue

    const size = normalizeSize(rawSize)
    if (size === null) continue

    siblingSizes.push({ asin: siblingAsin, size })
  }

  const categoryTree = product.categoryTree

  return { asin, title, categoryTree, siblingSizes }
}

/**
 * Live health check comparing categoryTree vs title gender signals across
 * keepa_raw (operator runs this against production; not part of the
 * candidate-mining path). Reports coverage and agreement so a future signal
 * regression is visible without re-deriving it from scratch.
 */
export function validateGenderSignals(db: DatabaseHandle): GenderSignalValidation {
  const rows = db.prepare('SELECT asin, payload FROM keepa_raw').iterate() as IterableIterator<KeepaRawRow>

  let familiesWithBoth = 0
  let agreement = 0
  let categoryOnly = 0
  let titleOnly = 0
  let neither = 0

  for (const row of rows) {
    const product = decodeProduct(row.payload)
    if (!product) continue

    const family = extractFamily(product)
    if (!family || family.siblingSizes.length === 0) continue

    const categoryGender = detectGenderFromCategoryTree(family.categoryTree)
    const titleGender = detectGenderFromTitle(family.title)

    if (categoryGender && titleGender) {
      familiesWithBoth += 1
      if (categoryGender === titleGender) agreement += 1
    } else if (categoryGender) {
      categoryOnly += 1
    } else if (titleGender) {
      titleOnly += 1
    } else {
      neither += 1
    }
  }

  return {
    familiesWithBoth,
    agreement,
    agreementRate: familiesWithBoth > 0 ? agreement / familiesWithBoth : 0,
    categoryOnly,
    titleOnly,
    neither,
  }
}

/**
 * Mine keepa_raw for untracked variation-sibling ASINs worth harvesting:
 * families with a determined gender (categoryTree first, title fallback),
 * sizes in that gender's "interesting" set, not already tracked or harvested.
 */
export function mineVariationCandidates(
  db: DatabaseHandle,
  options: MineVariationCandidatesOptions = {},
): MineVariationCandidatesResult {
  const log = options.log ?? (() => {})

  const trackedAsins = new Set(
    (db.prepare('SELECT asin FROM products').all() as Array<{ asin: string }>)
      .map((row) => row.asin.trim().toUpperCase()),
  )
  const harvestedAsins = new Set(
    (db.prepare(`
      SELECT asin FROM keepa_checkpoint WHERE status IN ('done', 'not_found')
    `).all() as Array<{ asin: string }>)
      .map((row) => row.asin.trim().toUpperCase()),
  )

  const stats: MineVariationCandidatesStats = {
    payloadsScanned: 0,
    familiesWithSizes: 0,
    genderFromCategory: 0,
    genderFromTitle: 0,
    genderUnresolvedSkipped: 0,
    siblingsSeen: 0,
    sizeFiltered: 0,
    alreadyTracked: 0,
    alreadyHarvested: 0,
    candidates: 0,
  }

  const candidateSet = new Set<string>()

  const rows = db.prepare('SELECT asin, payload FROM keepa_raw').iterate() as IterableIterator<KeepaRawRow>

  for (const row of rows) {
    stats.payloadsScanned += 1

    const product = decodeProduct(row.payload)
    if (!product) {
      log(`keepa-mine-variations: failed to decode payload for ${row.asin}`)
      continue
    }

    const family = extractFamily(product)
    if (!family || family.siblingSizes.length === 0) continue
    stats.familiesWithSizes += 1

    let gender = detectGenderFromCategoryTree(family.categoryTree)
    if (gender) {
      stats.genderFromCategory += 1
    } else {
      gender = detectGenderFromTitle(family.title)
      if (gender) {
        stats.genderFromTitle += 1
      } else {
        stats.genderUnresolvedSkipped += 1
        continue
      }
    }

    stats.siblingsSeen += family.siblingSizes.length
    const interesting = gender === 'M' ? INTERESTING_SIZES_M : INTERESTING_SIZES_W

    for (const sibling of family.siblingSizes) {
      if (!interesting.has(sibling.size)) {
        stats.sizeFiltered += 1
        continue
      }
      if (trackedAsins.has(sibling.asin)) {
        stats.alreadyTracked += 1
        continue
      }
      if (harvestedAsins.has(sibling.asin)) {
        stats.alreadyHarvested += 1
        continue
      }
      candidateSet.add(sibling.asin)
    }
  }

  const candidates = Array.from(candidateSet).sort()
  stats.candidates = candidates.length

  log(
    `keepa-mine-variations: payloadsScanned=${stats.payloadsScanned} ` +
    `familiesWithSizes=${stats.familiesWithSizes} candidates=${candidates.length}`,
  )

  return { candidates, stats }
}
