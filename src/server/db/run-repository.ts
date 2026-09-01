import type { GenerationRunStatus } from '../../shared/domain.js'
import type { Db } from './connection.js'

export type GenerationRunMode = 'generation' | 'recovery'
export type GenerationRunTrigger = 'post_commit' | 'registration' | 'manual_recovery'

export interface CommitRecord {
  projectId: string
  sha: string
  parentSha: string | null
  message: string
  authoredAt: string
  detectedAt: string
}

interface CommitRow {
  project_id: string
  sha: string
  parent_sha: string | null
  message: string
  authored_at: string
  detected_at: string
}

function rowToCommit(row: CommitRow): CommitRecord {
  return {
    projectId: row.project_id,
    sha: row.sha,
    parentSha: row.parent_sha,
    message: row.message,
    authoredAt: row.authored_at,
    detectedAt: row.detected_at,
  }
}

/** 同一 (project_id, sha) は detected_at を保ったまま metadata を更新する。 */
export function upsertCommit(db: Db, commit: CommitRecord): void {
  db.prepare(
    `INSERT INTO commits (project_id, sha, parent_sha, message, authored_at, detected_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, sha)
       DO UPDATE SET parent_sha = excluded.parent_sha,
                     message = excluded.message,
                     authored_at = excluded.authored_at`,
  ).run(
    commit.projectId,
    commit.sha,
    commit.parentSha,
    commit.message,
    commit.authoredAt,
    commit.detectedAt,
  )
}

export function getCommitRecord(db: Db, projectId: string, sha: string): CommitRecord | null {
  const row = db
    .prepare(
      'SELECT project_id, sha, parent_sha, message, authored_at, detected_at FROM commits WHERE project_id = ? AND sha = ?',
    )
    .get(projectId, sha) as CommitRow | undefined
  return row === undefined ? null : rowToCommit(row)
}

export function getLatestCommit(db: Db, projectId: string): CommitRecord | null {
  const row = db
    .prepare(
      'SELECT project_id, sha, parent_sha, message, authored_at, detected_at FROM commits WHERE project_id = ? ORDER BY detected_at DESC, sha DESC LIMIT 1',
    )
    .get(projectId) as CommitRow | undefined
  return row === undefined ? null : rowToCommit(row)
}

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

export function getLatestGenerationRun(db: Db, projectId: string): GenerationRunRecord | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM generation_runs WHERE project_id = ? ORDER BY detected_at DESC, id DESC LIMIT 1`,
    )
    .get(projectId) as GenerationRunRow | undefined
  return row === undefined ? null : rowToRun(row)
}

export function hasQueuedGenerationRuns(db: Db, projectId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM generation_runs WHERE project_id = ? AND status = 'queued' LIMIT 1")
      .get(projectId) !== undefined
  )
}

/** 全 project を通じて queued|running の generation run があるか (manual backup の待機判定用)。 */
export function hasActiveGenerationRuns(db: Db): boolean {
  return (
    db
      .prepare("SELECT 1 FROM generation_runs WHERE status IN ('queued', 'running') LIMIT 1")
      .get() !== undefined
  )
}

export function isGenerationTerminalForCommit(
  db: Db,
  projectId: string,
  commitSha: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM generation_runs
       WHERE project_id = ? AND commit_sha = ? AND status IN ('queued', 'running') LIMIT 1`,
    )
    .get(projectId, commitSha)
  // queued/running が無ければ terminal (該当 run が無い場合も「待つべきものが無い」= terminal 扱い)
  return row === undefined
}

/**
 * 対象projectの queued run を `detected_at ASC, id ASC` で 1 件だけ atomic に running へ遷移して返す。
 * 取れなければ null。
 */
export function claimNextQueuedGenerationRun(
  db: Db,
  projectId: string,
  now: Date = new Date(),
): GenerationRunRecord | null {
  const claim = db.transaction((): GenerationRunRecord | null => {
    const row = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM generation_runs
         WHERE project_id = ? AND status = 'queued'
         ORDER BY detected_at ASC, id ASC LIMIT 1`,
      )
      .get(projectId) as GenerationRunRow | undefined
    if (row === undefined) {
      return null
    }
    const startedAt = now.toISOString()
    const updated = db
      .prepare(
        "UPDATE generation_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
      )
      .run(startedAt, row.id)
    if (updated.changes !== 1) {
      return null
    }
    return rowToRun({ ...row, status: 'running', started_at: startedAt })
  })
  return claim()
}

type TerminalGenerationStatus = 'succeeded' | 'partial' | 'unrecoverable' | 'failed'

export function markRunTerminal(
  db: Db,
  runId: string,
  status: TerminalGenerationStatus,
  errorCode: string | null = null,
  errorMessage: string | null = null,
  now: Date = new Date(),
): void {
  db.prepare(
    'UPDATE generation_runs SET status = ?, error_code = ?, error_message = ?, finished_at = ? WHERE id = ?',
  ).run(status, errorCode, errorMessage, now.toISOString(), runId)
}

export function markRunFailed(
  db: Db,
  runId: string,
  errorCode: string,
  errorMessage: string | null = null,
  now: Date = new Date(),
): void {
  markRunTerminal(db, runId, 'failed', errorCode, errorMessage, now)
}

export function recordCodexCliVersion(db: Db, runId: string, version: string): void {
  db.prepare('UPDATE generation_runs SET ai_cli_version = ? WHERE id = ?').run(version, runId)
}

/** 対象scopeの running run をまとめて failed にする (stale lease 回収時など)。 */
export function failRunningGenerationRuns(
  db: Db,
  projectId: string,
  errorCode: string,
  now: Date = new Date(),
): number {
  const result = db
    .prepare(
      "UPDATE generation_runs SET status = 'failed', error_code = ?, finished_at = ? WHERE project_id = ? AND status = 'running'",
    )
    .run(errorCode, now.toISOString(), projectId)
  return result.changes
}
