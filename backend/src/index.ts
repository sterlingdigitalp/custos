import { pathToFileURL } from 'node:url'

import { buildServer } from './api/server.js'
import { getSettings, listProducts } from './db/repo.js'
import { openDatabase } from './db/schema.js'
import { startScheduler, type CustosClientFactory } from './scheduler/loop.js'
import { createCustosClient } from './spapi/client.js'

export async function main(): Promise<void> {
  const db = openDatabase('data/custos.db')
  const clientFactory: CustosClientFactory = () => createCustosClient(getSettings(db))
  const scheduler = startScheduler(db, clientFactory)
  const server = buildServer(db, { client: clientFactory, scheduler })
  const port = Number(process.env.PORT ?? 4_100)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }

  const shutdown = async (): Promise<void> => {
    scheduler.stop()
    await server.close()
    db.close()
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  await server.listen({ port, host: '0.0.0.0' })
  const settings = getSettings(db)
  const mode = settings.lwaClientId && settings.lwaClientSecret && settings.refreshToken
    ? 'live'
    : 'mock'
  console.log(`Custos backend listening on port ${port} — ${listProducts(db, false).length} products — ${mode} SP-API client`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
