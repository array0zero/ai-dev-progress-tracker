import type { GenerationRunStatus } from '../../shared/domain.js'
import type { Db } from './connection.js'

export type GenerationRunMode = 'generation' | 'recovery'
export type GenerationRunTrigger = 'post_commit' | 'registration' | 'manual_recovery'

export interface GenerationRunRecord {
  id: string
  dedupeKey: string
  projectId: string
  commitSha: string
  mode: GenerationRunMode
  trigger: GenerationRunTrigger
  status: GenerationRunStatus
  detectedAt: string
  startedAt: string | null
  finishedAt: string | null
  aiProvider: string
  aiCliVersion: string | null
  aiModel: string
  errorCode: string | null
  errorMessage: string | null
}

export interface NewGenerationRun {
  id: string
  dedupeKey: string
  projectId: string
  commitSha: string
  mode: GenerationRunMode
  trigger: GenerationRunTrigger
  detectedAt: string
}

interface GenerationRunRow {
  id: string
  dedupe_key: string
  project_id: string
  commit_sha: string
  mode: string
  trigger: string
  status: string
  detected_at: string
  started_at: string | null
  finished_at: string | null
  ai_provider: string
  ai_cli_version: string | null
  ai_model: string
  error_code: string | null
  error_message: string | null
}

const SELECT_COLUMNS =
  'id, dedupe_key, project_id, commit_sha, mode, trigger, status, detected_at, started_at, finished_at, ai_provider, ai_cli_version, ai_model, error_code, error_message'

function rowToRun(row: GenerationRunRow): GenerationRunRecord {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    projectId: row.project_id,
    commitSha: row.commit_sha,
    mode: row.mode as GenerationRunMode,
    trigger: row.trigger as GenerationRunTrigger,
    status: row.status as GenerationRunStatus,
    detectedAt: row.detected_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    aiProvider: row.ai_provider,
    aiCliVersion: row.ai_cli_version,
    aiModel: row.ai_model,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  }
}

/** dedupe_keyがUNIQUEなので、同一keyの重複queueはSQLite制約で弾かれる。 */
export function insertRun(db: Db, run: NewGenerationRun): void {
  db.prepare(
    `INSERT INTO generation_runs
       (id, dedupe_key, project_id, commit_sha, mode, trigger, status, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(run.id, run.dedupeKey, run.projectId, run.commitSha, run.mode, run.trigger, run.detectedAt)
}

export function getRunById(db: Db, id: string): GenerationRunRecord | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM generation_runs WHERE id = ?`).get(id) as
    | GenerationRunRow
    | undefined
  return row === undefined ? null : rowToRun(row)
}

export function findRunByDedupeKey(db: Db, dedupeKey: string): GenerationRunRecord | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM generation_runs WHERE dedupe_key = ?`)
    .get(dedupeKey) as GenerationRunRow | undefined
  return row === undefined ? null : rowToRun(row)
}

export function listRunsByProject(db: Db, projectId: string): GenerationRunRecord[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM generation_runs WHERE project_id = ? ORDER BY detected_at DESC, id DESC`,
    )
    .all(projectId) as GenerationRunRow[]
  return rows.map(rowToRun)
}
