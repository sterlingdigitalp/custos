import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import { normalizeKeepaProduct } from './normalize.js'
import { renormalizeAll } from './renormalize.js'

function seedRaw(
  db: DatabaseHandle,
  asin: string,
  csv: Array<number[] | null>,
  fetchedAt = '2026-07-20T00:00:00.000Z',
): void {
  const payload = gzipSync(Buffer.from(JSON.stringify({ asin, csv, domainId: 1 }), 'utf8'))
  db.prepare(`
    INSERT INTO keepa_raw (asin, domain, fetched_at, tokens_cost, payload)
    VALUES (@asin, 1, @fetched_at, 1, @payload)
  `).run({ asin, fetched_at: fetchedAt, payload })
}

function pointsForAsin(db: DatabaseHandle, asin: string): Array<{ metric: string; ts: string; value: number }> {
  return db.prepare(`
    SELECT metric, ts, value FROM keepa_points WHERE asin = ? ORDER BY metric, ts
  `).all(asin) as Array<{ metric: string; ts: string; value: number }>
}

// Pre-fix-shaped raw csv: amazon series with a -1 in the middle.
const CSV_A: Array<number[] | null> = new Array(36).fill(null)
CSV_A[0] = [100, -1, 200, 5000, 300, -1, 400, 6000] // amazon: -1,5000,-1,6000

const CSV_B: Array<number[] | null> = new Array(36).fill(null)
CSV_B[0] = [900, 7000, 1000, -1] // amazon: 7000,-1

describe('renormalizeAll', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('rebuilds keepa_points with -1 terminators from a raw payload seeded pre-fix (old, terminator-dropping shape)', () => {
    seedRaw(db, 'B0ASINAAA1', CSV_A)

    // Simulate a DB written by the OLD normalizer (terminators dropped) —
    // exactly what a real pre-K6.0 database looks like.
    db.prepare(`
      INSERT INTO keepa_points (asin, metric, ts, value) VALUES
      ('B0ASINAAA1', 'amazon', '2017-11-21T02:20:00.000Z', 5000),
      ('B0ASINAAA1', 'amazon', '2017-11-21T08:56:00.000Z', 6000)
    `).run()
    expect(pointsForAsin(db, 'B0ASINAAA1')).toHaveLength(2)

    const summary = renormalizeAll(db)

    expect(summary).toEqual({ asins: 1, pointsBefore: 2, pointsAfter: 4 })

    const rebuilt = pointsForAsin(db, 'B0ASINAAA1')
    expect(rebuilt).toHaveLength(4)
    expect(rebuilt.map((p) => p.value)).toEqual([-1, 5000, -1, 6000])

    // Must equal a direct normalize of the same raw payload.
    const expected = normalizeKeepaProduct({ asin: 'B0ASINAAA1', csv: CSV_A })
    expect(rebuilt.map((p) => ({ metric: p.metric, ts: p.ts, value: p.value }))).toEqual(
      expected.map((p) => ({ metric: p.metric, ts: p.ts, value: p.value })),
    )
  })

  it('is idempotent — a second run over unchanged raw payloads produces identical points', () => {
    seedRaw(db, 'B0ASINAAA1', CSV_A)
    seedRaw(db, 'B0ASINBBB2', CSV_B)

    const first = renormalizeAll(db)
    const firstPointsA = pointsForAsin(db, 'B0ASINAAA1')
    const firstPointsB = pointsForAsin(db, 'B0ASINBBB2')

    const second = renormalizeAll(db)
    const secondPointsA = pointsForAsin(db, 'B0ASINAAA1')
    const secondPointsB = pointsForAsin(db, 'B0ASINBBB2')

    expect(second).toEqual({
      asins: 2,
      pointsBefore: first.pointsAfter,
      pointsAfter: first.pointsAfter,
    })
    expect(secondPointsA).toEqual(firstPointsA)
    expect(secondPointsB).toEqual(firstPointsB)
  })

  it('processes each ASIN in its own transaction — leaves other ASINs untouched', () => {
    seedRaw(db, 'B0ASINAAA1', CSV_A)
    seedRaw(db, 'B0ASINBBB2', CSV_B)

    renormalizeAll(db)

    const pointsA = pointsForAsin(db, 'B0ASINAAA1')
    const pointsB = pointsForAsin(db, 'B0ASINBBB2')
    expect(pointsA).toHaveLength(4)
    expect(pointsB).toHaveLength(2)
    expect(pointsB.map((p) => p.value)).toEqual([7000, -1])
  })

  it('returns a zeroed summary and does nothing when keepa_raw is empty', () => {
    const summary = renormalizeAll(db)
    expect(summary).toEqual({ asins: 0, pointsBefore: 0, pointsAfter: 0 })
  })

  it('skips (and does not throw on) a corrupt/undecodable raw payload, continuing to other ASINs', () => {
    db.prepare(`
      INSERT INTO keepa_raw (asin, domain, fetched_at, tokens_cost, payload)
      VALUES ('B0CORRUPT1', 1, '2026-07-20T00:00:00.000Z', 1, ?)
    `).run(Buffer.from('not gzip data'))
    seedRaw(db, 'B0ASINBBB2', CSV_B)

    const messages: string[] = []
    const summary = renormalizeAll(db, { log: (m) => messages.push(m) })

    expect(summary.asins).toBe(1) // only the valid ASIN counted
    expect(pointsForAsin(db, 'B0ASINBBB2')).toHaveLength(2)
    expect(messages.some((m) => m.includes('B0CORRUPT1'))).toBe(true)
  })
})
