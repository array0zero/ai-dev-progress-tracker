import type { BackupRunStatus } from '../../shared/domain.js'
import type { Db } from './connection.js'

export type BackupRunTrigger = 'registration' | 'pre_push' | 'manual'

export interface BackupRunRecord {
  id: string
  trigger: BackupRunTrigger
  projectId: string | null
  sourceCommitSha: string | null
  status: BackupRunStatus
  backupRepo: string
  backupCommitSha: string | null
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  errorCode: string | null
  errorMessage: string | null
}

export interface NewBackupRun {
  id: string
  trigger: BackupRunTrigger
  projectId: string | null
  sourceCommitSha: string | null
  backupRepo: string
}

interface BackupRunRow {
  id: string
  trigger: string
  project_id: string | null
  source_commit_sha: string | null
  status: string
  backup_repo: string
  backup_commit_sha: string | null
  queued_at: string
  started_at: string | null
  finished_at: string | null
  error_code: string | null
  error_message: string | null
}

const SELECT_COLUMNS =
  'id, trigger, project_id, source_commit_sha, status, backup_repo, backup_commit_sha, queued_at, started_at, finished_at, error_code, error_message'

function rowToBackupRun(row: BackupRunRow): BackupRunRecord {
  return {
    id: row.id,
    trigger: row.trigger as BackupRunTrigger,
    projectId: row.project_id,
    sourceCommitSha: row.source_commit_sha,
    status: row.status as BackupRunStatus,
    backupRepo: row.backup_repo,
    backupCommitSha: row.backup_commit_sha,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  }
}

export function insertBackupRun(
  db: Db,
  run: NewBackupRun,
  now: Date = new Date(),
): BackupRunRecord {
  const queuedAt = now.toISOString()
  db.prepare(
    `INSERT INTO backup_runs
       (id, trigger, project_id, source_commit_sha, status, backup_repo, queued_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(run.id, run.trigger, run.projectId, run.sourceCommitSha, run.backupRepo, queuedAt)
  return {
    id: run.id,
    trigger: run.trigger,
    projectId: run.projectId,
    sourceCommitSha: run.sourceCommitSha,
    status: 'queued',
    backupRepo: run.backupRepo,
    backupCommitSha: null,
    queuedAt,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorMessage: null,
  }
}

export function getBackupRunById(db: Db, id: string): BackupRunRecord | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM backup_runs WHERE id = ?`).get(id) as
    | BackupRunRow
    | undefined
  return row === undefined ? null : rowToBackupRun(row)
}

export function getLatestBackupRun(db: Db): BackupRunRecord | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM backup_runs ORDER BY queued_at DESC, id DESC LIMIT 1`)
    .get() as BackupRunRow | undefined
  return row === undefined ? null : rowToBackupRun(row)
}
