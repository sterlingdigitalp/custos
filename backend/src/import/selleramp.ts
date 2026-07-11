import {
  createProduct,
  getProductByAsin,
  listProducts,
  updateProductCatalog,
  type ProductCatalogUpdate,
} from '../db/repo.js'
import type { DatabaseHandle } from '../db/schema.js'

const SELLERAMP_FIELDS = ['asin', 'name', 'image'] as const
const SELLERAMP_ASIN = /^B0[A-Z0-9]{8}$/
const SWEEP_DURATION_WARNING_THRESHOLD = 4_000

export interface SellerampRow {
  asin: string
  name: string
  image: string
}

export interface SellerampImportSummary {
  imported: number
  updatedMetadata: number
  skippedInvalid: number
  alreadyPresent: number
  totalTracked: number
  warning?: string
}

function tokenizeCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  const finishRecord = () => {
    record.push(field)
    if (record.some((value) => value.trim() !== '')) records.push(record)
    record = []
    field = ''
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }

    if (character === '"' && field === '') {
      quoted = true
    } else if (character === ',') {
      record.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      finishRecord()
    } else {
      field += character
    }
  }

  if (field !== '' || record.length > 0) finishRecord()
  return records
}

function normalizedHeader(value: string, index: number): string {
  const withoutBom = index === 0 ? value.replace(/^\uFEFF/, '') : value
  return withoutBom.trim().toLowerCase()
}

export function parseSelleramp(text: string): { rows: SellerampRow[]; skipped: number } {
  const records = tokenizeCsv(text)
  const header = records.shift()
  if (!header) return { rows: [], skipped: 0 }

  const headers = header.map(normalizedHeader)
  const seen = new Set<string>()
  const rows: SellerampRow[] = []
  let skipped = 0

  for (const values of records) {
    const mapped: SellerampRow = { asin: '', name: '', image: '' }
    headers.forEach((name, index) => {
      if ((SELLERAMP_FIELDS as readonly string[]).includes(name)) {
        mapped[name as keyof SellerampRow] = values[index] ?? ''
      }
    })

    const row = {
      asin: mapped.asin.trim(),
      name: mapped.name.trim(),
      image: mapped.image.trim(),
    }
    if (!SELLERAMP_ASIN.test(row.asin)) {
      skipped += 1
    } else if (!seen.has(row.asin)) {
      seen.add(row.asin)
      rows.push(row)
    }
  }

  return { rows, skipped }
}

export function importSelleramp(db: DatabaseHandle, text: string): SellerampImportSummary {
  const parsed = parseSelleramp(text)

  return db.transaction(() => {
    const summary: SellerampImportSummary = {
      imported: 0,
      updatedMetadata: 0,
      skippedInvalid: parsed.skipped,
      alreadyPresent: 0,
      totalTracked: 0,
    }

    for (const row of parsed.rows) {
      const existing = getProductByAsin(db, row.asin)
      if (!existing) {
        createProduct(db, {
          asin: row.asin,
          title: row.name || null,
          imageUrl: row.image || null,
          source: 'selleramp',
          isArchived: false,
        })
        summary.imported += 1
        continue
      }

      summary.alreadyPresent += 1
      const metadata: ProductCatalogUpdate = {}
      if (existing.title === null && row.name !== '') metadata.title = row.name
      if (existing.imageUrl === null && row.image !== '') metadata.imageUrl = row.image
      if (Object.keys(metadata).length > 0) {
        updateProductCatalog(db, row.asin, metadata)
        summary.updatedMetadata += 1
      }
    }

    summary.totalTracked = listProducts(db).length
    if (summary.totalTracked > SWEEP_DURATION_WARNING_THRESHOLD) {
      summary.warning = 'More than 4,000 active products are tracked; complete sweeps may take longer.'
    }
    return summary
  })()
}
