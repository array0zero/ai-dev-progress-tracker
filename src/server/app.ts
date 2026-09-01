import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig } from './config.js'
import type { Db } from './db/connection.js'
import { backupRoutes } from './routes/backup.js'
import { healthRoutes } from './routes/health.js'
import { projectRoutes } from './routes/projects.js'
import { systemRoutes } from './routes/system.js'

export interface BuildAppOptions {
  config: AppConfig
  db: Db
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function hostnameOf(hostHeader: string): string {
  const match = hostHeader.match(/^\[?([^\]]+?)\]?(?::\d+)?$/)
  return (match?.[1] ?? hostHeader).toLowerCase()
}

export async function buildApp({ config, db }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const allowedOrigins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ])

  // localhost 境界: 非 localhost Host を拒否。CORS header は付与しない。
  // Host のポートは強制しない (DNS rebinding 対策の本質は hostname、かつ app.inject 互換)。
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host
    if (host === undefined || !LOCAL_HOSTNAMES.has(hostnameOf(host))) {
      return reply
        .code(403)
        .send({ error: { code: 'FORBIDDEN_HOST', message: 'Host is not allowed.' } })
    }
    if (MUTATION_METHODS.has(request.method)) {
      const origin = request.headers.origin
      if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) {
        return reply
          .code(403)
          .send({ error: { code: 'FORBIDDEN_ORIGIN', message: 'Origin is not allowed.' } })
      }
    }
  })

  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(projectRoutes(db), { prefix: '/api' })
  await app.register(backupRoutes(db), { prefix: '/api' })
  await app.register(systemRoutes(db), { prefix: '/api' })

  if (existsSync(join(config.webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webRoot })

    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html')
      }
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Route not found.' },
      })
    })
  }

  return app
}
