import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProduct } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import {
  importKeepaStats,
  parseKeepaStats,
  previewKeepaStats,
} from './stats-import.js'

const NOW = () => new Date('2026-07-22T12:00:00.000Z')

describe('parseKeepaStats', () => {
  it('maps flexible headers and converts money cells', () => {
    const parsed = parseKeepaStats([
      'ASIN,buybox_90_min,buybox_90_max,buybox_90_avg,salesrank_90_min,salesrank_90_avg',
      'B00FLYWNYQ,79.95,129.99,99.50,100,250',
      'NOTANASIN,1,2,3,4,5',
    ].join('\n'))

    expect(parsed.skippedInvalid).toBe(1)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]!.asin).toBe('B00FLYWNYQ')
    expect(parsed.rows[0]!.cells).toEqual(
      expect.arrayContaining([
        { metric: 'buybox', window: '90', stat: 'min', raw: 79.95 },
        { metric: 'buybox', window: '90', stat: 'max', raw: 129.99 },
        { metric: 'buybox', window: '90', stat: 'avg', raw: 99.5 },
        { metric: 'salesrank', window: '90', stat: 'min', raw: 100 },
        { metric: 'salesrank', window: '90', stat: 'avg', raw: 250 },
      ]),
    )
  })

  it('accepts metric aliases and reordered columns', () => {
    const parsed = parseKeepaStats([
      'bb_30_avg,product_asin,rank_365_min,fba_30_max',
      '12.34,B0TEST0001,50,20.00',
    ].join('\n'))
    expect(parsed.rows[0]!.asin).toBe('B0TEST0001')
    expect(parsed.rows[0]!.cells.map((c) => c.metric).sort()).toEqual([
      'buybox', 'new_fba', 'salesrank',
    ])
  })
})

describe('previewKeepaStats / importKeepaStats', () => {
  let db: DatabaseHandle
  beforeEach(() => {
    db = openDatabase(':memory:')
    createProduct(db, { asin: 'B00FLYWNYQ', source: 'manual' })
    createProduct(db, { asin: 'B0TEST0001', source: 'manual' })
  })
  afterEach(() => db.close())

  const csv = [
    'asin,buybox_90_min,buybox_90_max,buybox_90_avg,salesrank_90_avg',
    'B00FLYWNYQ,79.95,129.99,99.50,200',
    'B0UNKNOWN1,10,20,15,1',
    'B0TEST0001,5.00,6.00,5.50,10',
    'BADASIN,1,2,3,4',
  ].join('\n')

  it('preview reports unknown ASINs without writing', () => {
    const preview = previewKeepaStats(db, csv)
    expect(preview.mode).toBe('preview')
    expect(preview.knownAsinCount).toBe(2)
    expect(preview.unknownAsinCount).toBe(1)
    expect(preview.skippedInvalid).toBe(1)
    expect(preview.statsRowsWouldWrite).toBe(4) // 2 asins * (buybox + salesrank)
    expect(preview.unknownAsins).toContain('B0UNKNOWN1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM keepa_stats').get()).toEqual({ n: 0 })
  })

  it('apply upserts keepa_stats with cents conversion and skips unknown', () => {
    const summary = importKeepaStats(db, csv, { now: NOW })
    expect(summary).toEqual({
      mode: 'apply',
      upserted: 4,
      unknownAsinSkipped: 1,
      skippedInvalid: 1,
      rowsProcessed: 3,
    })

    const buybox = db.prepare(`
      SELECT min_cents, max_cents, avg_cents, imported_at
      FROM keepa_stats WHERE asin = 'B00FLYWNYQ' AND window = '90' AND metric = 'buybox'
    `).get() as {
      min_cents: number
      max_cents: number
      avg_cents: number
      imported_at: string
    }
    expect(buybox).toEqual({
      min_cents: 7995,
      max_cents: 12_999,
      avg_cents: 9950,
      imported_at: '2026-07-22T12:00:00.000Z',
    })

    const rank = db.prepare(`
      SELECT avg_cents FROM keepa_stats
      WHERE asin = 'B00FLYWNYQ' AND window = '90' AND metric = 'salesrank'
    `).get() as { avg_cents: number }
    // non-money: stored as rounded raw integer
    expect(rank.avg_cents).toBe(200)
  })

  it('is idempotent on re-apply (upsert, same row count)', () => {
    expect(importKeepaStats(db, csv, { now: NOW }).upserted).toBe(4)
    const again = importKeepaStats(db, csv, { now: () => new Date('2026-07-23T00:00:00.000Z') })
    expect(again.upserted).toBe(4)
    expect(db.prepare('SELECT COUNT(*) AS n FROM keepa_stats').get()).toEqual({ n: 4 })
    const importedAt = db.prepare(
      "SELECT imported_at FROM keepa_stats WHERE asin = 'B00FLYWNYQ' AND metric = 'buybox'",
    ).get() as { imported_at: string }
    expect(importedAt.imported_at).toBe('2026-07-23T00:00:00.000Z')
  })
})
