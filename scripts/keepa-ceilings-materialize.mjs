#!/usr/bin/env node
// scripts/keepa-ceilings-materialize.mjs
//
// Batch precompute cache for CONTRIB-CEILING-CONTRACT.md: calls
// computeCeilings() for every active (non-archived) product ASIN and
// upserts the result into keepa_stats (one row per asin, window='ceilings',
// metric='buybox'). This is ONLY a cache — /contrib/ceilings computes
// on-read from the same computeCeilings() function, so the live endpoint
// and this materialized snapshot can never diverge in shape, only in
// staleness (Aurora uses the live endpoint; this cache exists for
// operator/analyst querying of keepa_stats directly).
//
// extra_json = the full computeCeilings() response (Money-shaped fields,
// same JSON Aurora sees). min_cents/max_cents/avg_cents are bare-integer
// convenience columns for simple SQL filtering — NOT part of the frozen
// contract — mapped as:
//   max_cents = buyboxCeiling.absoluteAllTime (hardest ever-seen ceiling)
//   avg_cents = buyboxCeiling.sustained1y     (documented sustained ceiling)
//   min_cents = buyboxFloorContext.sustained1y (documented sustained low)
// Any may be NULL (gap ASINs, or a metric couldn't be computed).
//
// Usage:
//   node scripts/keepa-ceilings-materialize.mjs [--db <path>] [--limit N]
//
// Imports the COMPILED dist/ output — run `npm run build:backend` first.
// Progress → stderr; JSON summary → stdout.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

function parseArgs(argv) {
  const args = { db: undefined, limit: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--db') args.db = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.error(`Usage: node scripts/keepa-ceilings-materialize.mjs [options]
  --db <path>   SQLite path (default data/custos.db)
  --limit N     Stop after N ASINs (smoke)`)
      process.exit(0)
    }
  }
  return args
}

async function loadCompiledModules() {
  try {
    const schemaModule = await import(join(repoRoot, 'dist/backend/src/db/schema.js'))
    const repoModule = await import(join(repoRoot, 'dist/backend/src/db/repo.js'))
    const ceilingsModule = await import(join(repoRoot, 'dist/backend/src/keepa/ceilings.js'))
    return { schemaModule, repoModule, ceilingsModule }
  } catch (err) {
    if (err && err.code === 'ERR_DLOPEN_FAILED') {
      console.error(
        'keepa-ceilings-materialize: better-sqlite3 failed to load a native binding — ' +
        'run this script with Node 22, e.g.:\n' +
        '  PATH="$HOME/.hermes/node/bin:$PATH" node scripts/keepa-ceilings-materialize.mjs',
      )
      process.exit(1)
    }
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('keepa-ceilings-materialize: dist/ output not found — run `npm run build:backend` first')
      process.exit(1)
    }
    throw err
  }
}

function centsOf(money) {
  if (!money || typeof money.amount !== 'string') return null
  const cents = Math.round(Number(money.amount) * 100)
  return Number.isFinite(cents) ? cents : null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { schemaModule, repoModule, ceilingsModule } = await loadCompiledModules()

  const dbPath = args.db ?? join(repoRoot, 'data/custos.db')
  const db = schemaModule.openDatabase(dbPath)

  try {
    const settings = repoModule.getSettings(db)
    let asins = repoModule.listProducts(db, true).map((p) => p.asin)
    if (Number.isFinite(args.limit)) asins = asins.slice(0, args.limit)

    console.error(`keepa-ceilings-materialize: ${asins.length} active ASIN(s) to materialize`)

    const upsert = db.prepare(`
      INSERT INTO keepa_stats (
        asin, window, metric, min_cents, max_cents, avg_cents, extra_json, imported_at
      ) VALUES (
        @asin, 'ceilings', 'buybox', @min_cents, @max_cents, @avg_cents, @extra_json, @imported_at
      )
      ON CONFLICT(asin, window, metric) DO UPDATE SET
        min_cents = excluded.min_cents,
        max_cents = excluded.max_cents,
        avg_cents = excluded.avg_cents,
        extra_json = excluded.extra_json,
        imported_at = excluded.imported_at
    `)

    const now = new Date()
    let written = 0
    let confident = 0
    let gaps = 0

    for (const asin of asins) {
      const result = ceilingsModule.computeCeilings(db, asin, {
        now, sweepIntervalMin: settings.sweepIntervalMin,
      })
      db.transaction(() => {
        upsert.run({
          asin,
          min_cents: centsOf(result.buyboxFloorContext.sustained1y),
          max_cents: centsOf(result.buyboxCeiling.absoluteAllTime),
          avg_cents: centsOf(result.buyboxCeiling.sustained1y),
          extra_json: JSON.stringify(result),
          imported_at: now.toISOString(),
        })
      })()
      written += 1
      if (result.coverage.confident) confident += 1
      if (result.buyboxCeiling.method && result.coverage.buyboxPoints === 0) gaps += 1
    }

    const summary = { asins: asins.length, written, confident, gaps }
    console.error(
      `keepa-ceilings-materialize: finished asins=${summary.asins} written=${summary.written} ` +
      `confident=${summary.confident} gaps=${summary.gaps}`,
    )
    console.log(JSON.stringify(summary, null, 2))
  } catch (err) {
    console.error(
      'keepa-ceilings-materialize: aborted:',
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  } finally {
    db.close()
  }
}

await main()
