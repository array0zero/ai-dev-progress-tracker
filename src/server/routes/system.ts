import type { FastifyPluginAsync } from 'fastify'
import type { SystemStatus } from '../../shared/api.js'
import { getLatestBackupRun } from '../db/backup-repository.js'
import type { Db } from '../db/connection.js'
import { listProjects } from '../db/project-repository.js'
import { getLatestGenerationRun } from '../db/run-repository.js'
import { inspectAgentIntegration } from '../services/agent-integration-service.js'

const GENERATION_FAILURE_STATUSES = new Set(['failed', 'unrecoverable'])

/**
 * DESIGN.md: latest generation/backup failure を一元表示する。
 * Host / Origin allowlist の hardening は T017 で app 側に追加する。
 */
export function systemRoutes(db: Db): FastifyPluginAsync {
  return async (app) => {
    app.get('/system/status', async (): Promise<SystemStatus> => {
      let latestGenerationFailure: SystemStatus['latestGenerationFailure'] = null
      for (const project of listProjects(db)) {
        const run = getLatestGenerationRun(db, project.id)
        if (run === null || !GENERATION_FAILURE_STATUSES.has(run.status)) {
          continue
        }
        if (
          latestGenerationFailure === null ||
          run.detectedAt > latestGenerationFailure.detectedAt
        ) {
          latestGenerationFailure = {
            projectId: project.id,
            projectName: project.name,
            runId: run.id,
            status: run.status,
            errorCode: run.errorCode,
            detectedAt: run.detectedAt,
          }
        }
      }

      const backup = getLatestBackupRun(db)
      const latestBackupFailure =
        backup !== null && backup.status === 'failed'
          ? { backupRunId: backup.id, errorCode: backup.errorCode, queuedAt: backup.queuedAt }
          : null

      return {
        latestGenerationFailure,
        latestBackupFailure,
        agentIntegration: inspectAgentIntegration(),
      }
    })
  }
}
