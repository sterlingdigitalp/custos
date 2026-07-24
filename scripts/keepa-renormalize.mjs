#!/usr/bin/env node
// scripts/keepa-renormalize.mjs
//
// One-time (repeatable) re-normalize pass: rebuilds keepa_points from the
// stored keepa_raw payloads using the current normalize.ts logic
// (KEEPA-BACKFILL.md K6.0 — preserves -1 gap terminators). No API tokens,
// no network access. Safe to run while a backfill is in progress: each
// ASIN is rewritten inside its own DELETE+INSERT transaction, same as
// backfill.ts's commitAsin.
//
// Usage:
//   node scripts/keepa-renormalize.mjs [--db <path>]
//
// Imports the COMPILED dist/ output — run `npm run build:backend` first.
// Progress → stderr; JSON summary → stdout.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

function parseArgs(argv) {
  const args = { db: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--db') args.db = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.error(`Usage: node scripts/keepa-renormalize.mjs [options]
  --db <path>   SQLite path (default data/custos.db)`)
      process.exit(0)
    }
  }
  return args
}

async function loadCompiledModules() {
  try {
    const schemaModule = await import(join(repoRoot, 'dist/backend/src/db/schema.js'))
    const renormalizeModule = await import(join(repoRoot, 'dist/backend/src/keepa/renormalize.js'))
    return { schemaModule, renormalizeModule }
  } catch (err) {
    if (err && err.code === 'ERR_DLOPEN_FAILED') {
      console.error(
        'keepa-renormalize: better-sqlite3 failed to load a native binding — ' +
        'run this script with Node 22, e.g.:\n' +
        '  PATH="$HOME/.hermes/node/bin:$PATH" node scripts/keepa-renormalize.mjs',
      )
      process.exit(1)
    }
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('keepa-renormalize: dist/ output not found — run `npm run build:backend` first')
      process.exit(1)
    }
    throw err
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { schemaModule, renormalizeModule } = await loadCompiledModules()

  const dbPath = args.db ?? join(repoRoot, 'data/custos.db')
  const db = schemaModule.openDatabase(dbPath)

  try {
    const summary = renormalizeModule.renormalizeAll(db, {
      log: (msg) => console.error(msg),
    })
    console.log(JSON.stringify(summary, null, 2))
  } catch (err) {
    console.error(
      'keepa-renormalize: aborted:',
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  } finally {
    db.close()
  }
}

await main()
