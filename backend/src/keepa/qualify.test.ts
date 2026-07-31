import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import { qualifyBySales } from './qualify.js'

const KEEPA_EPOCH_OFFSET_MINUTES = 21_564_000
const DEFAULT_SINCE_ISO = '2024-01-01T00:00:00.000Z'

/** Same formula as normalize.ts's keepaMinutesToIso, inverted — kept local
 * to the test so it doesn't rely on qualify.ts's internals. */
function isoToKeepaMinutes(iso: string): number {
  return Math.floor(Date.parse(iso) / 60_000) - KEEPA_EPOCH_OFFSET_MINUTES
}

function insertRaw(
  db: DatabaseHandle,
  asin: string,
  extra: Record<string, unknown> = {},
): void {
  const product = { asin, csv: new Array(36).fill(null), ...extra }
  const payload = gzipSync(Buffer.from(JSON.stringify(product), 'utf8'))
  db.prepare(`
    INSERT INTO keepa_raw (asin, domain, fetched_at, tokens_cost, payload)
    VALUES (@asin, 1, '2026-01-01T00:00:00.000Z', 1, @payload)
  `).run({ asin, payload })
}

describe('qualifyBySales', () => {
  let db: DatabaseHandle
  beforeEach(() => { db = openDatabase(':memory:') })
  afterEach(() => db.close())

  it('passes an ASIN with a >0-unit pair in-window', () => {
    const inWindow = isoToKeepaMinutes('2024-06-01T00:00:00.000Z')
    insertRaw(db, 'B0PASS00001', { monthlySoldHistory: [inWindow, 5] })

    const result = qualifyBySales(db, ['B0PASS00001'])
    expect(result.pass).toEqual(['B0PASS00001'])
    expect(result.peakUnits['B0PASS00001']).toBe(5)
    expect(result.failNoSales).toEqual([])
    expect(result.failNoData).toEqual([])
    expect(result.notHarvested).toEqual([])
  })

  it('fails an ASIN whose only sales are before the cutoff', () => {
    const beforeWindow = isoToKeepaMinutes('2023-06-01T00:00:00.000Z')
    insertRaw(db, 'B0EARLY0001', { monthlySoldHistory: [beforeWindow, 5] })

    const result = qualifyBySales(db, ['B0EARLY0001'], { sinceIso: DEFAULT_SINCE_ISO })
    expect(result.failNoSales).toEqual(['B0EARLY0001'])
    expect(result.pass).toEqual([])
  })

  it('reports failNoData when monthlySoldHistory is absent or empty', () => {
    insertRaw(db, 'B0NODATA01') // no monthlySoldHistory field
    insertRaw(db, 'B0NODATA02', { monthlySoldHistory: [] })

    const result = qualifyBySales(db, ['B0NODATA01', 'B0NODATA02'])
    expect(result.failNoData.sort()).toEqual(['B0NODATA01', 'B0NODATA02'])
    expect(result.pass).toEqual([])
  })

  it('reports notHarvested when there is no keepa_raw row', () => {
    const result = qualifyBySales(db, ['B0MISSING01'])
    expect(result.notHarvested).toEqual(['B0MISSING01'])
  })

  it('ignores -1 sentinels in either slot of the pair', () => {
    const inWindow = isoToKeepaMinutes('2024-06-01T00:00:00.000Z')
    insertRaw(db, 'B0SENTINEL1', {
      // keepaMinutes -1 with a real-looking unit count: ignored.
      // in-window keepaMinutes with units -1: ignored.
      monthlySoldHistory: [-1, 50, inWindow, -1],
    })

    const result = qualifyBySales(db, ['B0SENTINEL1'])
    expect(result.pass).toEqual([])
    expect(result.failNoSales).toEqual(['B0SENTINEL1'])
  })

  it('counts a sale exactly at the cutoff timestamp as in-window (boundary)', () => {
    const atCutoff = isoToKeepaMinutes(DEFAULT_SINCE_ISO)
    insertRaw(db, 'B0BOUNDARY1', { monthlySoldHistory: [atCutoff, 3] })

    const result = qualifyBySales(db, ['B0BOUNDARY1'], { sinceIso: DEFAULT_SINCE_ISO })
    expect(result.pass).toEqual(['B0BOUNDARY1'])
    expect(result.peakUnits['B0BOUNDARY1']).toBe(3)
  })

  it('dedupes input ASINs and tracks the peak in-window units', () => {
    const inWindow = isoToKeepaMinutes('2024-06-01T00:00:00.000Z')
    const laterInWindow = isoToKeepaMinutes('2024-09-01T00:00:00.000Z')
    insertRaw(db, 'B0PEAK00001', {
      monthlySoldHistory: [inWindow, 5, laterInWindow, 20],
    })

    const result = qualifyBySales(db, ['B0PEAK00001', 'b0peak00001'])
    expect(result.pass).toEqual(['B0PEAK00001'])
    expect(result.peakUnits['B0PEAK00001']).toBe(20)
  })
})
