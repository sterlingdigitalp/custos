#!/usr/bin/env node
// scripts/platform-resolve.mjs
//
// Eager bootstrap: resolve every active (non-archived) product ASIN missing a
// registry_product_map row against the Hub Registry (PLATFORM-INTEGRATION.md
// P1 / D3). Idempotent by identifier — re-runs are no-ops for already-mapped
// ASINs.
//
// Usage:
//   node scripts/platform-resolve.mjs [--db <path>]
//
// Requires env: HUB_BASE_URL, HISTORY_HUB_TOKEN, PLATFORM_ACCOUNT_ID
// Optional: PLATFORM_MARKETPLACE_ID (default ATVPDKIKX0DER)
//
// Imports the COMPILED dist/ output, so `npm run build` (or build:backend)
// must have been run first.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

function parseArgs(argv) {
  const args = { db: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i]
  }
  return args
}

async function loadCompiledModules() {
  try {
    const schemaModule = await import(join(repoRoot, 'dist/backend/src/db/schema.js'))
    const configModule = await import(join(repoRoot, 'dist/backend/src/platform/config.js'))
    const registryModule = await import(join(repoRoot, 'dist/backend/src/platform/registry.js'))
    const resolveAllModule = await import(join(repoRoot, 'dist/backend/src/platform/resolveAll.js'))
    return { schemaModule, configModule, registryModule, resolveAllModule }
  } catch (err) {
    if (err && err.code === 'ERR_DLOPEN_FAILED') {
      console.error(
        'platform-resolve: better-sqlite3 failed to load a native binding — ' +
        'run this script with Node 22, e.g.:\n' +
        '  PATH="$HOME/.hermes/node/bin:$PATH" node scripts/platform-resolve.mjs',
      )
      process.exit(1)
    }
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('platform-resolve: dist/ output not found — run `npm run build` first')
      process.exit(1)
    }
    throw err
  }
}

async function main() {
  const { db: dbPath } = parseArgs(process.argv.slice(2))
  const { schemaModule, configModule, registryModule, resolveAllModule } =
    await loadCompiledModules()

  let hubConfig
  try {
    hubConfig = configModule.loadHubConfig()
  } catch (err) {
    console.error(
      'platform-resolve: Hub config invalid:',
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  }
  if (!hubConfig) {
    console.error(
      'platform-resolve: Hub is not configured.\n' +
      'Set both HUB_BASE_URL and HISTORY_HUB_TOKEN (plus PLATFORM_ACCOUNT_ID)\n' +
      'to run the bootstrap resolve script. Standalone mode leaves the map empty.',
    )
    process.exit(1)
  }

  const db = schemaModule.openDatabase(dbPath ?? join(repoRoot, 'data/custos.db'))
  try {
    const client = new registryModule.RegistryClient(hubConfig)
    const summary = await resolveAllModule.resolveAllProducts(db, client, {
      log: (msg) => console.error(msg),
    })
    console.log(JSON.stringify({
      attempted: summary.attempted,
      resolved: summary.resolved,
      created: summary.created,
      conflicts: summary.conflicts,
      failed: summary.failed,
    }, null, 2))
    if (summary.details.length) {
      console.error('details:', JSON.stringify(summary.details, null, 2))
    }
    if (summary.failed > 0) process.exit(1)
  } catch (err) {
    console.error(
      'platform-resolve: aborted:',
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  } finally {
    db.close()
  }
}

await main()
