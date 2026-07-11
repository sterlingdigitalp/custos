import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

import { buildServer } from './api/server.js'
import { getSettings, listProducts } from './db/repo.js'
import { openDatabase } from './db/schema.js'
import { startScheduler, type CustosClientFactory } from './scheduler/loop.js'
import { createCustosClient } from './spapi/client.js'

export async function registerFrontend(
  server: FastifyInstance,
  frontendRoot = resolve(process.cwd(), 'frontend/dist'),
): Promise<boolean> {
  if (!existsSync(frontendRoot)) return false

  const spaIndexPath = resolve(frontendRoot, 'index.html')
  server.addHook('onSend', async (request, reply, payload) => {
    const pathname = request.url.split('?')[0]
    const isApiRoute = pathname === '/api' || pathname.startsWith('/api/')
    // Asset-like paths (anything with a file extension) must 404 cleanly:
    // serving them index.html turns a missing asset into an opaque MIME-type
    // error in the browser.
    const lastSegment = pathname.split('/').pop() ?? ''
    const looksLikeFile = lastSegment.includes('.')
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD'
    if (reply.statusCode === 404 && !isApiRoute && !looksLikeFile && isPageRequest) {
      reply.status(200).type('text/html')
      // Read per request, not at boot: the frontend gets rebuilt (new hashed
      // asset names) while the server keeps running; a boot-time cache serves
      // stale asset references after every rebuild.
      return await readFile(spaIndexPath)
    }
    return payload
  })
  await server.register(fastifyStatic, { root: frontendRoot, prefix: '/' })
  return true
}

export async function main(): Promise<void> {
  const db = openDatabase('data/custos.db')
  const clientFactory: CustosClientFactory = () => createCustosClient(getSettings(db))
  const scheduler = startScheduler(db, clientFactory)
  const server = buildServer(db, { client: clientFactory, scheduler })
  const port = Number(process.env.PORT ?? 4_100)

  await registerFrontend(server)
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
