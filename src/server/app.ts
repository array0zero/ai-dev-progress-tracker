import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig } from './config.js'
import type { Db } from './db/connection.js'
import { healthRoutes } from './routes/health.js'
import { projectRoutes } from './routes/projects.js'

export interface BuildAppOptions {
  config: AppConfig
  db: Db
}

export async function buildApp({ config, db }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(projectRoutes(db), { prefix: '/api' })

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
