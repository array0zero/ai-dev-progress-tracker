import type { FastifyPluginAsync } from 'fastify'
import type { ApiErrorBody } from '../../shared/api.js'
import type { Db } from '../db/connection.js'
import { registerProjectRequestSchema } from '../schemas/project.js'
import { type RegisterProjectResult, registerProject } from '../services/project-service.js'

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } }
}

export function projectRoutes(db: Db): FastifyPluginAsync {
  return async (app) => {
    app.post('/projects', async (request, reply) => {
      const parsed = registerProjectRequestSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send(errorBody('INVALID_REQUEST', 'Request body is invalid.'))
      }

      let result: RegisterProjectResult
      try {
        result = await registerProject(parsed.data, db)
      } catch {
        return reply
          .code(500)
          .send(errorBody('INTERNAL_ERROR', 'Unexpected error during registration.'))
      }

      if (!result.ok) {
        return reply.code(result.status).send(errorBody(result.code, result.message))
      }
      return reply.code(201).send(result.project)
    })
  }
}
