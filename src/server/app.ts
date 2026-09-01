import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { type AppConfig, loadConfig } from './config.js'
import { healthRoutes } from './routes/health.js'

export interface BuildAppOptions {
  config?: AppConfig
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig()
  const app = Fastify({ logger: false })

  await app.register(healthRoutes, { prefix: '/api' })

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
