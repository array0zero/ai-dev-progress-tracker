import type { FastifyPluginAsync } from 'fastify'
import type { HealthResponse } from '../../shared/api.js'

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (): Promise<HealthResponse> => {
    return { status: 'ok', db: 'ok' }
  })
}
