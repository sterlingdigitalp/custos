// Mines Keepa variation siblings (shoe-corpus expansion candidates).
//
// Every keepa_raw payload is a Keepa product with (sometimes) a
// `variations` array listing sibling ASINs of the same style in other
// sizes/colors. We want the "interesting" untracked sizes — the ones a
// reseller is most likely to be able to find/flip — for products whose
// gender we can determine (from title, or inferred from the family's own
// size spread when the title is silent).
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

/**
 * Gender-inference rule (used only when the title gives no signal):
 * max normalized size >= this → 'M'; <= this → 'W'; between → ambiguous
 * (skipped). See validateGenderInference() for measured accuracy.
 */
export const GENDER_INFERENCE_MAX_SIZE_M = 12.5
export const GENDER_INFERENCE_MAX_SIZE_W = 10.5

export interface MineVariationCandidatesOptions {
  log?: (message: string) => void
}

export interface MineVariationCandidatesStats {
  payloadsScanned: number
  familiesWithSizes: number
  genderFromTitle: number
  genderInferred: number
  genderAmbiguousSkipped: number
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

export interface GenderInferenceValidation {
  /** Families with a title-determined gender (the ground truth set). */
  totalKnown: number
  /** Of those, how many the size-based rule was willing to call. */
  applicable: number
  /** Of the applicable calls, how many matched the title-determined gender. */
  correct: number
  /** correct / applicable (0 when nothing was applicable). */
  accuracy: number
}

interface SiblingSize {
  asin: string
  /** Canonical normalized size string, e.g. "10.5". */
  size: string
}

interface FamilyInfo {
  asin: string
  title: string | null
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
 * Infer gender from a family's own normalized sibling sizes when the title
 * gave no signal. Returns null (ambiguous) when the max size falls between
 * the two thresholds — callers should skip those families rather than guess.
 */
export function inferGenderFromSizes(sizes: number[]): Gender | null {
  if (sizes.length === 0) return null
  const max = Math.max(...sizes)
  if (max >= GENDER_INFERENCE_MAX_SIZE_M) return 'M'
  if (max <= GENDER_INFERENCE_MAX_SIZE_W) return 'W'
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

  return { asin, title, siblingSizes }
}

/**
 * Run the gender-inference rule against families whose gender IS known
 * from the title, and report how often it agrees. Used as a documented
 * confidence check on inferGenderFromSizes() before trusting it on
 * title-silent families.
 */
export function validateGenderInference(db: DatabaseHandle): GenderInferenceValidation {
  const rows = db.prepare('SELECT asin, payload FROM keepa_raw').iterate() as IterableIterator<KeepaRawRow>

  let totalKnown = 0
  let applicable = 0
  let correct = 0

  for (const row of rows) {
    const product = decodeProduct(row.payload)
    if (!product) continue

    const family = extractFamily(product)
    if (!family || family.siblingSizes.length === 0) continue

    const actual = detectGenderFromTitle(family.title)
    if (!actual) continue
    totalKnown += 1

    const inferred = inferGenderFromSizes(family.siblingSizes.map((s) => parseFloat(s.size)))
    if (inferred === null) continue
    applicable += 1
    if (inferred === actual) correct += 1
  }

  return {
    totalKnown,
    applicable,
    correct,
    accuracy: applicable > 0 ? correct / applicable : 0,
  }
}

/**
 * Mine keepa_raw for untracked variation-sibling ASINs worth harvesting:
 * families with a determined gender (title, or size-inferred), sizes in
 * that gender's "interesting" set, not already tracked or harvested.
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
    genderFromTitle: 0,
    genderInferred: 0,
    genderAmbiguousSkipped: 0,
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

    let gender = detectGenderFromTitle(family.title)
    if (gender) {
      stats.genderFromTitle += 1
    } else {
      const inferred = inferGenderFromSizes(family.siblingSizes.map((s) => parseFloat(s.size)))
      if (inferred) {
        gender = inferred
        stats.genderInferred += 1
      } else {
        stats.genderAmbiguousSkipped += 1
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
