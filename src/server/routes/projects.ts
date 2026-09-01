import type { FastifyPluginAsync } from 'fastify'
import type { ApiErrorBody, DecisionView, ProjectDetail, ProjectSummary } from '../../shared/api.js'
import { getLatestBackupRun } from '../db/backup-repository.js'
import type { Db } from '../db/connection.js'
import {
  getLatestProgress,
  getLatestSnapshotByProject,
  readSnapshotView,
  resolveEvidence,
} from '../db/progress-repository.js'
import { getProjectById, listProjects, type ProjectRecord } from '../db/project-repository.js'
import { getLatestCommit, getLatestGenerationRun } from '../db/run-repository.js'
import { registerProjectRequestSchema } from '../schemas/project.js'
import { startGenerationWorker } from '../services/generation-service.js'
import { type RegisterProjectResult, registerProject } from '../services/project-service.js'
import { enqueueRecovery } from '../services/recovery-service.js'

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } }
}

/**
 * dashboard/detail 共通の read model。
 * 最新 snapshot (detected_at DESC, created_at DESC) の field を反映し、
 * 古い commit の遅延完了で最終反映 commit を巻き戻さない。
 */
function baseSummary(db: Db, project: ProjectRecord): ProjectSummary {
  const latestGeneration = getLatestGenerationRun(db, project.id)
  const latestBackup = getLatestBackupRun(db)
  const progress = getLatestProgress(db, project.id)

  if (progress === null) {
    return {
      id: project.id,
      name: project.name,
      repository: `${project.repoOwner}/${project.repoName}`,
      repositoryUrl: project.repoUrl,
      lastCommitSha: getLatestCommit(db, project.id)?.sha ?? null,
      progressStatus: null,
      currentPosition: null,
      completedItems: [],
      nextActions: [],
      generationStatus: latestGeneration?.status ?? null,
      backupStatus:
        latestBackup !== null && latestBackup.projectId === project.id ? latestBackup.status : null,
    }
  }

  const { snapshot, view } = progress
  return {
    id: project.id,
    name: project.name,
    repository: `${project.repoOwner}/${project.repoName}`,
    repositoryUrl: project.repoUrl,
    lastCommitSha: snapshot.commitSha,
    progressStatus: view.recoveryStatus,
    currentPosition:
      view.currentPosition.status === 'needs_input' ? null : view.currentPosition.text,
    completedItems:
      view.completedItems.status === 'needs_input'
        ? []
        : view.completedItems.items.map((item) => item.text),
    nextActions:
      view.nextActions.status === 'needs_input'
        ? []
        : view.nextActions.items.map((item) => item.text),
    generationStatus: latestGeneration?.status ?? null,
    backupStatus:
      latestBackup !== null && latestBackup.projectId === project.id ? latestBackup.status : null,
  }
}

type DetailResult =
  | { ok: true; detail: ProjectDetail }
  | { ok: false; status: number; code: string; message: string }

function buildProjectDetail(db: Db, projectId: string): DetailResult {
  const project = getProjectById(db, projectId)
  if (project === null) {
    return { ok: false, status: 404, code: 'PROJECT_NOT_FOUND', message: 'Project not found.' }
  }

  const summary = baseSummary(db, project)
  const emptyDetail: ProjectDetail = {
    ...summary,
    importantDecisions: [],
    allEvidence: [],
    missingFields: [],
  }

  const snapshot = getLatestSnapshotByProject(db, projectId)
  if (snapshot === null) {
    return { ok: true, detail: emptyDetail }
  }

  const view = readSnapshotView(snapshot)
  if (view === null) {
    return {
      ok: false,
      status: 422,
      code: 'SNAPSHOT_INCONSISTENT',
      message: 'The latest progress snapshot is not in the expected format.',
    }
  }

  const { byId, missing } = resolveEvidence(db, projectId, view.evidenceIds)
  if (missing.length > 0) {
    return {
      ok: false,
      status: 422,
      code: 'SNAPSHOT_INCONSISTENT',
      message: `The latest snapshot references evidence that is not available: ${missing.join(', ')}`,
    }
  }

  const missingFields: string[] = []
  if (view.currentPosition.status === 'needs_input') {
    missingFields.push('currentPosition')
  }
  if (view.completedItems.status === 'needs_input') {
    missingFields.push('completedItems')
  }
  if (view.nextActions.status === 'needs_input') {
    missingFields.push('nextActions')
  }
  if (view.importantDecisions.status === 'needs_input') {
    missingFields.push('importantDecisions')
  }

  const decisions: DecisionView[] = view.importantDecisions.items.map((item) => ({
    decision: item.decision,
    rationale: item.rationale,
    evidence: item.evidenceIds
      .map((id) => byId.get(id))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined),
  }))

  const detail: ProjectDetail = {
    ...summary,
    progressStatus: view.recoveryStatus,
    currentPosition:
      view.currentPosition.status === 'needs_input' ? null : view.currentPosition.text,
    completedItems:
      view.completedItems.status === 'needs_input'
        ? []
        : view.completedItems.items.map((item) => item.text),
    nextActions:
      view.nextActions.status === 'needs_input'
        ? []
        : view.nextActions.items.map((item) => item.text),
    importantDecisions: decisions,
    allEvidence: [...byId.values()],
    missingFields,
  }
  return { ok: true, detail }
}

export function projectRoutes(db: Db): FastifyPluginAsync {
  return async (app) => {
    app.get('/projects', async () => listProjects(db).map((project) => baseSummary(db, project)))

    app.get('/projects/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = buildProjectDetail(db, id)
      if (!result.ok) {
        return reply.code(result.status).send(errorBody(result.code, result.message))
      }
      return result.detail
    })

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

    app.post('/projects/:id/recover', async (request, reply) => {
      const { id } = request.params as { id: string }
      if (getProjectById(db, id) === null) {
        return reply.code(404).send(errorBody('PROJECT_NOT_FOUND', 'Project not found.'))
      }
      const recovery = enqueueRecovery(db, id, 'manual_recovery')
      if (!recovery.ok) {
        return reply.code(recovery.status).send(errorBody(recovery.code, recovery.code))
      }
      if (recovery.shouldSpawn && recovery.ownerToken !== null) {
        startGenerationWorker(db, recovery.scope, recovery.ownerToken, recovery.runId)
      }
      return reply.code(202).send({ runId: recovery.runId, status: 'queued' })
    })
  }
}
