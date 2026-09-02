import { randomUUID } from 'node:crypto'
import type { RegistrationCandidate, RegistrationCandidateStatus } from '../../shared/domain.js'
import type { Db } from './connection.js'

interface CandidateRow {
  id: string
  local_path: string
  agent: string
  status: string
  suggested_name: string
  detected_at: string
  last_seen_at: string
  prompted_at: string | null
  decision_at: string | null
  attempt_count: number
  last_error_code: string | null
  last_error_message: string | null
  project_id: string | null
}

const SELECT_COLUMNS =
  'id, local_path, agent, status, suggested_name, detected_at, last_seen_at, prompted_at, decision_at, attempt_count, last_error_code, last_error_message, project_id'

function rowToCandidate(row: CandidateRow): RegistrationCandidate {
  return {
    id: row.id,
    localPath: row.local_path,
    agent: row.agent as RegistrationCandidate['agent'],
    status: row.status as RegistrationCandidateStatus,
    suggestedName: row.suggested_name,
    detectedAt: row.detected_at,
    lastSeenAt: row.last_seen_at,
    promptedAt: row.prompted_at,
    decisionAt: row.decision_at,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    projectId: row.project_id,
  }
}

export interface DetectedCandidateInput {
  localPath: string
  agent: RegistrationCandidate['agent']
  suggestedName: string
}

export function getCandidate(db: Db, id: string): RegistrationCandidate | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM registration_candidates WHERE id = ?`)
    .get(id) as CandidateRow | undefined
  return row === undefined ? null : rowToCandidate(row)
}

export function findCandidateByLocalPath(db: Db, localPath: string): RegistrationCandidate | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM registration_candidates WHERE local_path = ?`)
    .get(localPath) as CandidateRow | undefined
  return row === undefined ? null : rowToCandidate(row)
}

export function listCandidates(
  db: Db,
  status?: RegistrationCandidateStatus,
): RegistrationCandidate[] {
  const where = status === undefined ? '' : 'WHERE status = ?'
  const params = status === undefined ? [] : [status]
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM registration_candidates ${where} ORDER BY last_seen_at DESC, id ASC`,
    )
    .all(...params) as CandidateRow[]
  return rows.map(rowToCandidate)
}

/**
 * 同一 folder の Codex/Claude event を 1 candidate へ収束させる。
 * 既存 candidate の status/agent は保持し、last_seen_at だけを進める。
 */
export function upsertDetected(
  db: Db,
  input: DetectedCandidateInput,
  now: Date = new Date(),
): RegistrationCandidate {
  const ts = now.toISOString()
  db.prepare(
    `INSERT INTO registration_candidates
       (id, local_path, agent, status, suggested_name, detected_at, last_seen_at, attempt_count)
     VALUES (?, ?, ?, 'detected', ?, ?, ?, 0)
     ON CONFLICT(local_path) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(randomUUID(), input.localPath, input.agent, input.suggestedName, ts, ts)
  const candidate = findCandidateByLocalPath(db, input.localPath)
  if (candidate === null) {
    throw new Error('candidate upsert did not produce a row')
  }
  return candidate
}

/** 登録確認 UI を出した。detected/prompted からのみ。 */
export function markPrompted(db: Db, id: string, now: Date = new Date()): boolean {
  const ts = now.toISOString()
  return (
    db
      .prepare(
        `UPDATE registration_candidates
         SET status = 'prompted', prompted_at = COALESCE(prompted_at, ?)
         WHERE id = ? AND status IN ('detected', 'prompted')`,
      )
      .run(ts, id).changes === 1
  )
}

/**
 * 承認 (attempt 1) と自動 retry (attempt 2) の両方の入口。
 * attempt_count は 2 で頭打ちにし、3 回目の attempt を state 側で拒否する。
 */
export function beginRegistration(
  db: Db,
  id: string,
  now: Date = new Date(),
  nameOverride: string | null = null,
): boolean {
  const ts = now.toISOString()
  return (
    db
      .prepare(
        `UPDATE registration_candidates
         SET status = 'registering',
             decision_at = COALESCE(decision_at, ?),
             suggested_name = COALESCE(?, suggested_name),
             attempt_count = attempt_count + 1
         WHERE id = ?
           AND (
             (status IN ('detected', 'prompted') AND attempt_count = 0)
             OR (status = 'registering' AND attempt_count = 1)
           )`,
      )
      .run(ts, nameOverride === null ? null : nameOverride.slice(0, 120), id).changes === 1
  )
}

/** attempt 失敗。2 attempt 使い切っていたら failed で確定する。 */
export function recordFailure(
  db: Db,
  id: string,
  errorCode: string,
  errorMessage: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE registration_candidates
         SET last_error_code = ?,
             last_error_message = ?,
             status = CASE WHEN attempt_count >= 2 THEN 'failed' ELSE status END
         WHERE id = ? AND status = 'registering'`,
      )
      .run(errorCode.slice(0, 64), errorMessage.slice(0, 500), id).changes === 1
  )
}

export function markRegistered(db: Db, id: string, projectId: string): boolean {
  return (
    db
      .prepare(
        `UPDATE registration_candidates
         SET status = 'registered', project_id = ?, last_error_code = NULL, last_error_message = NULL
         WHERE id = ? AND status = 'registering'`,
      )
      .run(projectId, id).changes === 1
  )
}

/** 拒否。auto registration は起動せず candidate 行は残す。 */
export function declineCandidate(db: Db, id: string, now: Date = new Date()): boolean {
  return (
    db
      .prepare(
        `UPDATE registration_candidates
         SET status = 'declined', decision_at = ?
         WHERE id = ? AND status IN ('detected', 'prompted')`,
      )
      .run(now.toISOString(), id).changes === 1
  )
}

/** declined/failed をやり直す。新しい 2-attempt cycle のため attempt/error を reset する。 */
export function reopenCandidate(db: Db, id: string): boolean {
  return (
    db
      .prepare(
        `UPDATE registration_candidates
         SET status = 'detected',
             attempt_count = 0,
             decision_at = NULL,
             last_error_code = NULL,
             last_error_message = NULL
         WHERE id = ? AND status IN ('declined', 'failed')`,
      )
      .run(id).changes === 1
  )
}
