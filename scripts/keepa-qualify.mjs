#!/usr/bin/env node
// scripts/keepa-qualify.mjs
//
// Filters candidate ASINs (from keepa-mine-variations.mjs, or any
// newline-delimited list) by real Amazon sales evidence — Keepa's
// monthlySoldHistory on the stored keepa_raw payload
// (backend/src/keepa/qualify.ts). No API tokens, no network access.
//
// Usage:
//   node scripts/keepa-qualify.mjs --in candidates.txt --out passing.txt [--db <path>] [--since <ISO>]
//
// Imports the COMPILED dist/ output — run `npm run build:backend` first.
// Progress → stderr; JSON summary → stdout.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

function parseArgs(argv) {
  const args = { db: undefined, in: undefined, out: undefined, since: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--db') args.db = argv[++i]
    else if (arg === '--in') args.in = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--since') args.since = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.error(`Usage: node scripts/keepa-qualify.mjs [options]
  --db <path>       SQLite path (default data/custos.db)
  --in <file>       Newline-delimited candidate ASINs (required)
  --out <file>      Write newline-delimited passing ASINs (required)
  --since <ISO>     Only count sales at-or-after this date (default 2024-01-01)`)
      process.exit(0)
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

async function loadCompiledModules() {
  try {
    const schemaModule = await import(join(repoRoot, 'dist/backend/src/db/schema.js'))
    const qualifyModule = await import(join(repoRoot, 'dist/backend/src/keepa/qualify.js'))
    return { schemaModule, qualifyModule }
  } catch (err) {
    if (err && err.code === 'ERR_DLOPEN_FAILED') {
      console.error(
        'keepa-qualify: better-sqlite3 failed to load a native binding — ' +
        'run this script with Node 22, e.g.:\n' +
        '  PATH="$HOME/.hermes/node/bin:$PATH" node scripts/keepa-qualify.mjs',
      )
      process.exit(1)
    }
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('keepa-qualify: dist/ output not found — run `npm run build:backend` first')
      process.exit(1)
    }
    throw err
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.in) {
    console.error('keepa-qualify: --in <file> is required')
    process.exit(1)
  }
  if (!args.out) {
    console.error('keepa-qualify: --out <file> is required')
    process.exit(1)
  }

  const { schemaModule, qualifyModule } = await loadCompiledModules()

  let asins
  try {
    asins = loadAsinFile(args.in)
    console.error(`keepa-qualify: loaded ${asins.length} candidate ASIN(s) from ${args.in}`)
  } catch (err) {
    console.error('keepa-qualify: failed to read --in:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  const dbPath = args.db ?? join(repoRoot, 'data/custos.db')
  const db = schemaModule.openDatabase(dbPath)

  try {
    const result = qualifyModule.qualifyBySales(db, asins, {
      sinceIso: args.since,
      log: (msg) => console.error(msg),
    })

    const body = result.pass.length > 0 ? result.pass.join('\n') + '\n' : ''
    writeFileSync(args.out, body, 'utf8')
    console.error(`keepa-qualify: wrote ${result.pass.length} passing ASIN(s) to ${args.out}`)

    console.log(JSON.stringify({
      pass: result.pass.length,
      failNoSales: result.failNoSales.length,
      failNoData: result.failNoData.length,
      notHarvested: result.notHarvested.length,
      peakUnits: result.peakUnits,
    }, null, 2))
  } catch (err) {
    console.error('keepa-qualify: aborted:', err instanceof Error ? err.message : err)
    process.exit(1)
  } finally {
    db.close()
  }
}

await main()
