import type { FastifyPluginAsync } from 'fastify'
import type { ApiErrorBody, ProjectSummary } from '../../shared/api.js'
import type { Db } from '../db/connection.js'
import { listProjects } from '../db/project-repository.js'
import { getLatestCommit } from '../db/run-repository.js'
import { registerProjectRequestSchema } from '../schemas/project.js'
import { type RegisterProjectResult, registerProject } from '../services/project-service.js'

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } }
}

/**
 * dashboard 用の read model。最新 snapshot / generation / backup の join は
 * それらを作る T011 以降で追加する。現状は project + 最終反映 commit のみ。
 */
function listProjectSummaries(db: Db): ProjectSummary[] {
  return listProjects(db).map((project) => ({
    id: project.id,
    name: project.name,
    repository: `${project.repoOwner}/${project.repoName}`,
    repositoryUrl: project.repoUrl,
    lastCommitSha: getLatestCommit(db, project.id)?.sha ?? null,
    progressStatus: null,
    currentPosition: null,
    completedItems: [],
    nextActions: [],
    generationStatus: null,
    backupStatus: null,
  }))
}

export function projectRoutes(db: Db): FastifyPluginAsync {
  return async (app) => {
    app.get('/projects', async () => listProjectSummaries(db))

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
