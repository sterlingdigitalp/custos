#!/usr/bin/env node
// scripts/keepa-backfill.mjs
//
// Checkpointed Keepa history backfill (KEEPA-BACKFILL.md K4/K5).
//
// Usage:
//   KEEPA_API_KEY=… node scripts/keepa-backfill.mjs [--db <path>]
//     [--priority-file <path>] [--limit N] [--dry-run]
//
// Requires env: KEEPA_API_KEY (never logged).
// Imports the COMPILED dist/ output — run `npm run build:backend` first.
// Progress → stderr; JSON summary → stdout. Exit 1 when failed > 0.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

function parseArgs(argv) {
  const args = {
    db: undefined,
    priorityFile: undefined,
    limit: undefined,
    dryRun: false,
    batchSize: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--db') args.db = argv[++i]
    else if (arg === '--priority-file') args.priorityFile = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg === '--batch-size') args.batchSize = Number(argv[++i])
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      console.error(`Usage: KEEPA_API_KEY=… node scripts/keepa-backfill.mjs [options]
  --db <path>              SQLite path (default data/custos.db)
  --priority-file <path>   Newline-separated ASINs (P1 first)
  --limit N                Stop after N ASINs (smoke)
  --batch-size N           ASINs per request (default 100, max 100)
  --dry-run                List work; no API requests`)
      process.exit(0)
    }
  }
  return args
}

function loadPriorityFile(path) {
  const text = readFileSync(path, 'utf8')
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

async function loadCompiledModules() {
  try {
    const schemaModule = await import(join(repoRoot, 'dist/backend/src/db/schema.js'))
    const clientModule = await import(join(repoRoot, 'dist/backend/src/keepa/client.js'))
    const backfillModule = await import(join(repoRoot, 'dist/backend/src/keepa/backfill.js'))
    return { schemaModule, clientModule, backfillModule }
  } catch (err) {
    if (err && err.code === 'ERR_DLOPEN_FAILED') {
      console.error(
        'keepa-backfill: better-sqlite3 failed to load a native binding — ' +
        'run this script with Node 22, e.g.:\n' +
        '  PATH="$HOME/.hermes/node/bin:$PATH" node scripts/keepa-backfill.mjs',
      )
      process.exit(1)
    }
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('keepa-backfill: dist/ output not found — run `npm run build:backend` first')
      process.exit(1)
    }
    throw err
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = process.env.KEEPA_API_KEY
  if (!apiKey || apiKey.trim() === '') {
    console.error('keepa-backfill: KEEPA_API_KEY is required')
    process.exit(1)
  }

  const { schemaModule, clientModule, backfillModule } = await loadCompiledModules()

  let priorityAsins = []
  if (args.priorityFile) {
    try {
      priorityAsins = loadPriorityFile(args.priorityFile)
      console.error(`keepa-backfill: loaded ${priorityAsins.length} priority ASIN(s) from ${args.priorityFile}`)
    } catch (err) {
      console.error(
        'keepa-backfill: failed to read --priority-file:',
        err instanceof Error ? err.message : err,
      )
      process.exit(1)
    }
  }

  const dbPath = args.db ?? join(repoRoot, 'data/custos.db')
  const db = schemaModule.openDatabase(dbPath)

  try {
    if (args.dryRun) {
      let work = backfillModule.buildKeepaWorkList(db, priorityAsins)
      if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
        work = work.slice(0, args.limit)
      }
      console.error(`keepa-backfill: dry-run — ${work.length} ASIN(s) would be fetched`)
      for (const asin of work.slice(0, 20)) {
        console.error(`  ${asin}`)
      }
      if (work.length > 20) console.error(`  … and ${work.length - 20} more`)
      console.log(JSON.stringify({
        dryRun: true,
        workCount: work.length,
        sample: work.slice(0, 20),
      }, null, 2))
      return
    }

    const client = new clientModule.KeepaClient({ apiKey })
    const summary = await backfillModule.runKeepaBackfill(db, client, {
      priorityAsins,
      batchSize: Number.isFinite(args.batchSize) ? args.batchSize : undefined,
      limit: Number.isFinite(args.limit) ? args.limit : undefined,
      log: (msg) => console.error(msg),
    })

    console.log(JSON.stringify(summary, null, 2))
    if (summary.failed > 0) process.exit(1)
  } catch (err) {
    console.error(
      'keepa-backfill: aborted:',
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  } finally {
    db.close()
  }
}

await main()
