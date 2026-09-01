import type { FastifyPluginAsync } from 'fastify'
import type { ApiErrorBody } from '../../shared/api.js'
import { getActiveLogin } from '../adapters/github.js'
import { hasActiveBackupRun } from '../db/backup-repository.js'
import type { Db } from '../db/connection.js'
import { BACKUP_REPO_SUFFIX, enqueueBackup, startBackupWorker } from '../services/backup-service.js'

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } }
}

export function backupRoutes(db: Db): FastifyPluginAsync {
  return async (app) => {
    app.post('/backup', async (_request, reply) => {
      if (hasActiveBackupRun(db)) {
        return reply
          .code(409)
          .send(errorBody('BACKUP_ALREADY_ACTIVE', 'A backup run is already in progress.'))
      }
      const login = await getActiveLogin()
      const backupRepo = login === null ? BACKUP_REPO_SUFFIX : `${login}/${BACKUP_REPO_SUFFIX}`

      const enqueued = enqueueBackup(db, {
        trigger: 'manual',
        projectId: null,
        sourceCommitSha: null,
        backupRepo,
      })
      if (enqueued.shouldSpawn && enqueued.ownerToken !== null) {
        startBackupWorker(db, enqueued.ownerToken, enqueued.runId)
      }
      return reply.code(202).send({ backupRunId: enqueued.runId, status: 'queued' })
    })
  }
}
