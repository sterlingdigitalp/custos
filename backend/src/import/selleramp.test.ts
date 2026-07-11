import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProduct, getProductByAsin, listProducts } from '../db/repo.js'
import { openDatabase, type DatabaseHandle } from '../db/schema.js'
import { importSelleramp, parseSelleramp } from './selleramp.js'

describe('parseSelleramp', () => {
  it('parses valid rows and counts invalid ASINs as skipped', () => {
    const parsed = parseSelleramp([
      'asin,name,image',
      'B0TEST0001,Valid product,https://example.test/valid.jpg',
      'NOTANASIN,Invalid product,https://example.test/invalid.jpg',
    ].join('\n'))

    expect(parsed).toEqual({
      rows: [{
        asin: 'B0TEST0001',
        name: 'Valid product',
        image: 'https://example.test/valid.jpg',
      }],
      skipped: 1,
    })
  })

  it('keeps a comma inside a double-quoted product name', () => {
    const parsed = parseSelleramp([
      'asin,name,image',
      'B0TEST0001,"Widget, Large",https://example.test/widget.jpg',
    ].join('\n'))

    expect(parsed.rows).toEqual([{
      asin: 'B0TEST0001',
      name: 'Widget, Large',
      image: 'https://example.test/widget.jpg',
    }])
    expect(parsed.skipped).toBe(0)
  })

  it('keeps only the first occurrence of a duplicate ASIN', () => {
    const parsed = parseSelleramp([
      'asin,name,image',
      'B0TEST0001,First title,first.jpg',
      'B0TEST0001,Second title,second.jpg',
    ].join('\n'))

    expect(parsed.rows).toEqual([{
      asin: 'B0TEST0001',
      name: 'First title',
      image: 'first.jpg',
    }])
    expect(parsed.skipped).toBe(0)
  })

  it('maps fields by header when columns are reordered', () => {
    const parsed = parseSelleramp([
      'name,image,asin',
      'Reordered product,https://example.test/reordered.jpg,B0TEST0002',
    ].join('\n'))

    expect(parsed.rows).toEqual([{
      asin: 'B0TEST0002',
      name: 'Reordered product',
      image: 'https://example.test/reordered.jpg',
    }])
  })

  it('allows valid rows with empty name and image fields', () => {
    expect(parseSelleramp('asin,name,image\nB0TEST0001,,')).toEqual({
      rows: [{ asin: 'B0TEST0001', name: '', image: '' }],
      skipped: 0,
    })
  })
})

describe('importSelleramp', () => {
  let db: DatabaseHandle

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  afterEach(() => db.close())

  it('inserts new ASINs as active SellerAmp products', () => {
    const summary = importSelleramp(db, [
      'asin,name,image',
      'B0TEST0001,First product,https://example.test/first.jpg',
      'B0TEST0002,Second product,https://example.test/second.jpg',
    ].join('\n'))

    expect(summary).toEqual({
      imported: 2,
      updatedMetadata: 0,
      skippedInvalid: 0,
      alreadyPresent: 0,
      totalTracked: 2,
    })
    expect(getProductByAsin(db, 'B0TEST0001')).toMatchObject({
      asin: 'B0TEST0001',
      title: 'First product',
      imageUrl: 'https://example.test/first.jpg',
      source: 'selleramp',
      isArchived: false,
    })
    expect(getProductByAsin(db, 'B0TEST0002')).toMatchObject({
      asin: 'B0TEST0002',
      title: 'Second product',
      imageUrl: 'https://example.test/second.jpg',
      source: 'selleramp',
      isArchived: false,
    })
  })

  it('leaves non-null metadata on an existing product untouched', () => {
    createProduct(db, {
      asin: 'B0TEST0001',
      title: 'Existing title',
      imageUrl: 'existing.jpg',
      source: 'manual',
    })

    const summary = importSelleramp(
      db,
      'asin,name,image\nB0TEST0001,Imported title,imported.jpg',
    )

    expect(summary).toEqual({
      imported: 0,
      updatedMetadata: 0,
      skippedInvalid: 0,
      alreadyPresent: 1,
      totalTracked: 1,
    })
    expect(getProductByAsin(db, 'B0TEST0001')).toMatchObject({
      title: 'Existing title',
      imageUrl: 'existing.jpg',
      source: 'manual',
    })
  })

  it('fills null metadata on an existing product', () => {
    createProduct(db, {
      asin: 'B0TEST0001',
      title: null,
      imageUrl: null,
      source: 'manual',
    })

    const summary = importSelleramp(
      db,
      'asin,name,image\nB0TEST0001,Filled title,filled.jpg',
    )

    expect(summary).toEqual({
      imported: 0,
      updatedMetadata: 1,
      skippedInvalid: 0,
      alreadyPresent: 1,
      totalTracked: 1,
    })
    expect(getProductByAsin(db, 'B0TEST0001')).toMatchObject({
      title: 'Filled title',
      imageUrl: 'filled.jpg',
      source: 'manual',
    })
  })

  it('is idempotent when the same CSV is imported twice', () => {
    const csv = [
      'asin,name,image',
      'B0TEST0001,First product,first.jpg',
      'B0TEST0002,Second product,second.jpg',
    ].join('\n')

    expect(importSelleramp(db, csv).imported).toBe(2)
    expect(importSelleramp(db, csv)).toEqual({
      imported: 0,
      updatedMetadata: 0,
      skippedInvalid: 0,
      alreadyPresent: 2,
      totalTracked: 2,
    })
    expect(listProducts(db, false)).toHaveLength(2)
  })

  it('counts invalid-ASIN rows as skipped without inserting them', () => {
    const summary = importSelleramp(db, [
      'asin,name,image',
      'NOTANASIN,Invalid product,invalid.jpg',
      'B0TEST0001,Valid product,valid.jpg',
    ].join('\n'))

    expect(summary).toEqual({
      imported: 1,
      updatedMetadata: 0,
      skippedInvalid: 1,
      alreadyPresent: 0,
      totalTracked: 1,
    })
    expect(getProductByAsin(db, 'NOTANASIN')).toBeUndefined()
    expect(listProducts(db, false).map(({ asin }) => asin)).toEqual(['B0TEST0001'])
  })

  it('reports the post-import count of non-archived products', () => {
    createProduct(db, { asin: 'ACTIVE0001', isArchived: false })
    createProduct(db, { asin: 'ARCHIVED01', isArchived: true })

    const summary = importSelleramp(
      db,
      'asin,name,image\nB0TEST0001,Imported product,imported.jpg',
    )

    expect(summary.totalTracked).toBe(2)
    expect(listProducts(db)).toHaveLength(2)
    expect(listProducts(db, false)).toHaveLength(3)
  })

  it('warns above 4,000 active products but not at the threshold', () => {
    db.transaction(() => {
      for (let index = 0; index < 3_999; index += 1) {
        createProduct(db, { asin: `PRE${String(index).padStart(7, '0')}` })
      }
    })()

    const atThreshold = importSelleramp(
      db,
      'asin,name,image\nB0THRESH00,Threshold product,threshold.jpg',
    )
    expect(atThreshold.totalTracked).toBe(4_000)
    expect(atThreshold.warning).toBeUndefined()

    const aboveThreshold = importSelleramp(
      db,
      'asin,name,image\nB0THRESH01,Above threshold,above.jpg',
    )
    expect(aboveThreshold.totalTracked).toBe(4_001)
    expect(aboveThreshold.warning).toEqual(expect.any(String))
    expect(aboveThreshold.warning).not.toHaveLength(0)
  })
})
