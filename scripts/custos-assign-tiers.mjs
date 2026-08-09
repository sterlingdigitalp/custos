#!/usr/bin/env node
// scripts/custos-assign-tiers.mjs
//
// Tier-aware sweep scheduling (see backend/src/collector/sweep.ts,
// backend/src/scheduler/loop.ts). Marks HOT the ASINs that drive repricing
// and alerts; everything else in the corpus is marked COLD. Hot ASINs sweep
// every cycle; cold ASINs rotate across settings.coldSweepDivisor cycles.
//
// Usage:
//   node scripts/custos-assign-tiers.mjs [--hot-file <path>]... \
//     [--hot-from-manifest <path>] [--db <path>] [--dry-run]
//
// --hot-file <path>            Newline-separated ASINs (repeatable; blank
//                               lines and lines starting with # are ignored).
// --hot-from-manifest <path>   Ledger's sold-asin-manifest.json; hot ASINs
//                               are read from entries[].asin.
// At least one of --hot-file / --hot-from-manifest is required.
//
// Imports the COMPILED dist/ output — run `npm run build:backend` first.
// Progress → stderr; JSON summary → stdout: {hot, cold, changed}.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

function parseArgs(argv) {
  const args = { hotFiles: [], hotFromManifest: undefined, db: undefined, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--hot-file') args.hotFiles.push(argv[++i])
    else if (arg === '--hot-from-manifest') args.hotFromManifest = argv[++i]
    else if (arg === '--db') args.db = argv[++i]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      console.error(`Usage: node scripts/custos-assign-tiers.mjs [options]
  --hot-file <path>            Newline-separated ASINs (repeatable)
  --hot-from-manifest <path>   Ledger's sold-asin-manifest.json (entries[].asin)
  --db <path>                  SQLite path (default data/custos.db)
  --dry-run                    Compute the summary; write nothing`)
      process.exit(0)
    } else {
      console.error(`custos-assign-tiers: unrecognized argument: ${arg}`)
      process.exit(1)
    }
  }
  return args
}

function loadAsinFile(path) {
  const text = readFileSync(path, 'utf8')
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

function loadManifestAsins(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
  return entries
    .map((entry) => (entry && typeof entry.asin === 'string' ? entry.asin.trim() : undefined))
    .filter((asin) => asin !== undefined && asin !== '')
}

async function loadCompiledModules() {
  try {
    const schemaModule = await import(join(repoRoot, 'dist/backend/src/db/schema.js'))
    const repoModule = await import(join(repoRoot, 'dist/backend/src/db/repo.js'))
    return { schemaModule, repoModule }
  } catch (err) {
    if (err && err.code === 'ERR_DLOPEN_FAILED') {
      console.error(
        'custos-assign-tiers: better-sqlite3 failed to load a native binding — ' +
        'run this script with Node 22, e.g.:\n' +
        '  PATH="$HOME/.hermes/node/bin:$PATH" node scripts/custos-assign-tiers.mjs',
      )
      process.exit(1)
    }
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('custos-assign-tiers: dist/ output not found — run `npm run build:backend` first')
      process.exit(1)
    }
    throw err
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.hotFiles.length === 0 && !args.hotFromManifest) {
    console.error('custos-assign-tiers: at least one of --hot-file or --hot-from-manifest is required')
    process.exit(1)
  }

  const hotAsins = new Set()
  for (const path of args.hotFiles) {
    try {
      const asins = loadAsinFile(path)
      asins.forEach((asin) => hotAsins.add(asin))
      console.error(`custos-assign-tiers: loaded ${asins.length} ASIN(s) from ${path}`)
    } catch (err) {
      console.error(`custos-assign-tiers: failed to read --hot-file ${path}:`, err instanceof Error ? err.message : err)
      process.exit(1)
    }
  }
  if (args.hotFromManifest) {
    try {
      const asins = loadManifestAsins(args.hotFromManifest)
      asins.forEach((asin) => hotAsins.add(asin))
      console.error(`custos-assign-tiers: loaded ${asins.length} ASIN(s) from ${args.hotFromManifest}`)
    } catch (err) {
      console.error(
        `custos-assign-tiers: failed to read --hot-from-manifest ${args.hotFromManifest}:`,
        err instanceof Error ? err.message : err,
      )
      process.exit(1)
    }
  }
  console.error(`custos-assign-tiers: ${hotAsins.size} unique hot ASIN(s) requested`)

  const { schemaModule, repoModule } = await loadCompiledModules()
  const dbPath = args.db ?? join(repoRoot, 'data/custos.db')
  const db = schemaModule.openDatabase(dbPath)

  try {
    const products = repoModule.listProducts(db, false)
    const hotList = []
    const coldList = []
    let changed = 0
    for (const product of products) {
      const desiredTier = hotAsins.has(product.asin) ? 'hot' : 'cold'
      if (desiredTier === 'hot') hotList.push(product.asin)
      else coldList.push(product.asin)
      if (product.tier !== desiredTier) changed += 1
    }

    const missing = [...hotAsins].filter((asin) => !products.some((p) => p.asin === asin))
    if (missing.length > 0) {
      console.error(`custos-assign-tiers: ${missing.length} requested hot ASIN(s) are not in the corpus and will be skipped`)
    }

    if (!args.dryRun) {
      repoModule.setProductTier(db, hotList, 'hot')
      repoModule.setProductTier(db, coldList, 'cold')
    }

    const summary = { hot: hotList.length, cold: coldList.length, changed }
    console.error(
      args.dryRun
        ? `custos-assign-tiers: dry-run — would mark ${summary.hot} hot / ${summary.cold} cold (${summary.changed} changed)`
        : `custos-assign-tiers: marked ${summary.hot} hot / ${summary.cold} cold (${summary.changed} changed)`,
    )
    console.log(JSON.stringify(summary, null, 2))
  } catch (err) {
    console.error('custos-assign-tiers: aborted:', err instanceof Error ? err.message : err)
    process.exit(1)
  } finally {
    db.close()
  }
}

await main()
