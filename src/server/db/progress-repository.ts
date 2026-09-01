import type { ProgressRecoveryStatus } from '../../shared/domain.js'
import type { Db } from './connection.js'

export interface ProgressSnapshotRecord {
  id: string
  generationRunId: string
  projectId: string
  commitSha: string
  recoveryStatus: ProgressRecoveryStatus
  currentPosition: unknown
  completedItems: unknown
  nextActions: unknown
  decisions: unknown
  createdAt: string
}

export interface NewProgressSnapshot {
  id: string
  generationRunId: string
  projectId: string
  commitSha: string
  recoveryStatus: ProgressRecoveryStatus
  currentPosition: unknown
  completedItems: unknown
  nextActions: unknown
  decisions: unknown
}

interface ProgressSnapshotRow {
  id: string
  generation_run_id: string
  project_id: string
  commit_sha: string
  recovery_status: string
  current_position_json: string
  completed_items_json: string
  next_actions_json: string
  decisions_json: string
  created_at: string
}

const SELECT_COLUMNS =
  'id, generation_run_id, project_id, commit_sha, recovery_status, current_position_json, completed_items_json, next_actions_json, decisions_json, created_at'

function rowToSnapshot(row: ProgressSnapshotRow): ProgressSnapshotRecord {
  return {
    id: row.id,
    generationRunId: row.generation_run_id,
    projectId: row.project_id,
    commitSha: row.commit_sha,
    recoveryStatus: row.recovery_status as ProgressRecoveryStatus,
    currentPosition: JSON.parse(row.current_position_json),
    completedItems: JSON.parse(row.completed_items_json),
    nextActions: JSON.parse(row.next_actions_json),
    decisions: JSON.parse(row.decisions_json),
    createdAt: row.created_at,
  }
}

export function insertSnapshot(
  db: Db,
  snapshot: NewProgressSnapshot,
  now: Date = new Date(),
): ProgressSnapshotRecord {
  const createdAt = now.toISOString()
  db.prepare(
    `INSERT INTO progress_snapshots
       (id, generation_run_id, project_id, commit_sha, recovery_status,
        current_position_json, completed_items_json, next_actions_json, decisions_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshot.id,
    snapshot.generationRunId,
    snapshot.projectId,
    snapshot.commitSha,
    snapshot.recoveryStatus,
    JSON.stringify(snapshot.currentPosition),
    JSON.stringify(snapshot.completedItems),
    JSON.stringify(snapshot.nextActions),
    JSON.stringify(snapshot.decisions),
    createdAt,
  )
  return { ...snapshot, createdAt }
}

export function getSnapshotByRunId(db: Db, generationRunId: string): ProgressSnapshotRecord | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM progress_snapshots WHERE generation_run_id = ?`)
    .get(generationRunId) as ProgressSnapshotRow | undefined
  return row === undefined ? null : rowToSnapshot(row)
}
