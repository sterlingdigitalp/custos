import { newId } from '@platform/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createProduct,
  getMappingByAsin,
  listActiveAsinsMissingMapping,
  upsertProductMapping,
} from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'

describe('registry_product_map repository', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('creates registry_product_map via openDatabase', () => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registry_product_map'
    `).all() as Array<{ name: string }>
    expect(tables).toHaveLength(1)
  })

  it('upserts and reads mappings by ASIN', () => {
    const prd = newId('prd', 600_000)
    const mapping = upsertProductMapping(db, {
      asin: 'B00FLYWNYQ',
      canonicalProductId: prd,
      registryVersion: 1,
      createdByUs: true,
      resolvedAt: '2026-07-17T00:00:00.000Z',
    })
    expect(mapping).toMatchObject({
      asin: 'B00FLYWNYQ',
      canonicalProductId: prd,
      registryVersion: 1,
      createdByUs: true,
      resolvedAt: '2026-07-17T00:00:00.000Z',
    })
    expect(getMappingByAsin(db, 'B00FLYWNYQ')).toEqual(mapping)

    const prd2 = newId('prd', 600_001)
    const updated = upsertProductMapping(db, {
      asin: 'B00FLYWNYQ',
      canonicalProductId: prd2,
      registryVersion: 2,
      createdByUs: false,
      resolvedAt: '2026-07-17T01:00:00.000Z',
    })
    expect(updated.canonicalProductId).toBe(prd2)
    expect(updated.registryVersion).toBe(2)
    expect(updated.createdByUs).toBe(false)
    expect(getMappingByAsin(db, 'B00MISSING')).toBeUndefined()
  })

  it('lists only active ASINs missing a mapping row', () => {
    createProduct(db, { asin: 'B00ACTIVE01' })
    createProduct(db, { asin: 'B00ACTIVE02' })
    createProduct(db, { asin: 'B00ARCHIVED', isArchived: true })
    upsertProductMapping(db, {
      asin: 'B00ACTIVE01',
      canonicalProductId: newId('prd', 600_000),
    })

    expect(listActiveAsinsMissingMapping(db)).toEqual(['B00ACTIVE02'])
  })
})
