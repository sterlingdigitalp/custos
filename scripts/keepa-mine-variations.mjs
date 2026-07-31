#!/usr/bin/env node
// scripts/keepa-mine-variations.mjs
//
// Mines keepa_raw variation siblings for shoe-corpus expansion candidates
// (backend/src/keepa/variations.ts). No API tokens, no network access —
// reads only the already-harvested keepa_raw payloads.
//
// Usage:
//   node scripts/keepa-mine-variations.mjs --out candidates.txt [--db <path>]
//   node scripts/keepa-mine-variations.mjs --dry-run [--db <path>]
//
// Imports the COMPILED dist/ output — run `npm run build:backend` first.
// Progress + gender-inference accuracy → stderr; JSON stats → stdout.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

function parseArgs(argv) {
  const args = { db: undefined, out: undefined, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--db') args.db = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      console.error(`Usage: node scripts/keepa-mine-variations.mjs [options]
  --db <path>   SQLite path (default data/custos.db)
  --out <file>  Write newline-delimited candidate ASINs (required unless --dry-run)
  --dry-run     Stats only; no file written`)
      process.exit(0)
    }
  }
  return args
}

async function loadCompiledModules() {
  try {
    const schemaModule = await import(join(repoRoot, 'dist/backend/src/db/schema.js'))
    const variationsModule = await import(join(repoRoot, 'dist/backend/src/keepa/variations.js'))
    return { schemaModule, variationsModule }
  } catch (err) {
    if (err && err.code === 'ERR_DLOPEN_FAILED') {
      console.error(
        'keepa-mine-variations: better-sqlite3 failed to load a native binding — ' +
        'run this script with Node 22, e.g.:\n' +
        '  PATH="$HOME/.hermes/node/bin:$PATH" node scripts/keepa-mine-variations.mjs',
      )
      process.exit(1)
    }
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('keepa-mine-variations: dist/ output not found — run `npm run build:backend` first')
      process.exit(1)
    }
    throw err
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dryRun && !args.out) {
    console.error('keepa-mine-variations: --out <file> is required (or pass --dry-run)')
    process.exit(1)
  }

  const { schemaModule, variationsModule } = await loadCompiledModules()

  const dbPath = args.db ?? join(repoRoot, 'data/custos.db')
  const db = schemaModule.openDatabase(dbPath)

  try {
    const validation = variationsModule.validateGenderInference(db)
    console.error(
      `keepa-mine-variations: gender-inference accuracy=${(validation.accuracy * 100).toFixed(1)}% ` +
      `(${validation.correct}/${validation.applicable} applicable of ${validation.totalKnown} known-gender families)`,
    )

    const { candidates, stats } = variationsModule.mineVariationCandidates(db, {
      log: (msg) => console.error(msg),
    })

    if (args.dryRun) {
      console.error(`keepa-mine-variations: dry-run — ${candidates.length} candidate(s), no file written`)
      for (const asin of candidates.slice(0, 20)) console.error(`  ${asin}`)
      if (candidates.length > 20) console.error(`  … and ${candidates.length - 20} more`)
    } else {
      const body = candidates.length > 0 ? candidates.join('\n') + '\n' : ''
      writeFileSync(args.out, body, 'utf8')
      console.error(`keepa-mine-variations: wrote ${candidates.length} candidate(s) to ${args.out}`)
    }

    console.log(JSON.stringify({ stats, genderInferenceAccuracy: validation }, null, 2))
  } catch (err) {
    console.error(
      'keepa-mine-variations: aborted:',
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  } finally {
    db.close()
  }
}

await main()
