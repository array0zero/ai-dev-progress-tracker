import { randomUUID } from 'node:crypto'
import type { Db } from '../db/connection.js'
import { getProjectById } from '../db/project-repository.js'
import { getLatestCommit } from '../db/run-repository.js'
import { type EnqueueGenerationResult, enqueueGeneration } from './generation-service.js'

export type RecoveryTrigger = 'registration' | 'manual_recovery'

export type EnqueueRecoveryResult =
  | { ok: true; runId: string; scope: string; shouldSpawn: boolean; ownerToken: string | null }
  | { ok: false; status: number; code: string }

function recoveryDedupeKey(projectId: string, sha: string): string {
  // recovery は明示 retry を重ねられるよう、毎回ユニークな key にする。
  return `recovery:${projectId}:${sha}:${randomUUID()}`
}

/**
 * DESIGN.md「Recovery」: snapshot 欠落時 / 明示 retry 時に、最新 commit と
 * 取得可能な GitHub 根拠から再生成する `recovery` run を queue する。
 * 同 project に active な run があれば RUN_ALREADY_ACTIVE。
 */
export function enqueueRecovery(
  db: Db,
  projectId: string,
  trigger: RecoveryTrigger,
  now: () => Date = () => new Date(),
): EnqueueRecoveryResult {
  const project = getProjectById(db, projectId)
  if (project === null) {
    return { ok: false, status: 404, code: 'PROJECT_NOT_FOUND' }
  }

  const active = db
    .prepare(
      "SELECT 1 FROM generation_runs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1",
    )
    .get(projectId)
  if (active !== undefined) {
    return { ok: false, status: 409, code: 'RUN_ALREADY_ACTIVE' }
  }

  // HEAD が無い project では再生成を開始しない (DESIGN: 422 INVALID_REQUEST)。
  const commit = getLatestCommit(db, projectId)
  if (commit === null) {
    return { ok: false, status: 422, code: 'INVALID_REQUEST' }
  }

  const result: EnqueueGenerationResult = enqueueGeneration(
    db,
    {
      projectId,
      sha: commit.sha,
      mode: 'recovery',
      trigger,
      dedupeKey: recoveryDedupeKey(projectId, commit.sha),
    },
    now,
  )

  return {
    ok: true,
    runId: result.runId,
    scope: result.scope,
    shouldSpawn: result.shouldSpawn,
    ownerToken: result.ownerToken,
  }
}
