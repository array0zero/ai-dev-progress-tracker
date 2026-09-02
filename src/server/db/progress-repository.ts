import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { EvidenceRef } from '../../shared/api.js'
import type { ProgressRecoveryStatus } from '../../shared/domain.js'
import type { Db } from './connection.js'

export type EvidenceKind = 'commit' | 'issue' | 'pull_request'

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

/**
 * DESIGN.md: dashboard/detail が採用するのは
 * `commits.detected_at DESC, progress_snapshots.created_at DESC` の先頭 1 件。
 */
export function getLatestSnapshotByProject(
  db: Db,
  projectId: string,
): ProgressSnapshotRecord | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS.split(', ')
        .map((column) => `ps.${column}`)
        .join(', ')}
       FROM progress_snapshots ps
       JOIN commits c ON c.project_id = ps.project_id AND c.sha = ps.commit_sha
       WHERE ps.project_id = ?
       ORDER BY c.detected_at DESC, ps.created_at DESC
       LIMIT 1`,
    )
    .get(projectId) as ProgressSnapshotRow | undefined
  return row === undefined ? null : rowToSnapshot(row)
}

const fieldStatusSchema = z.enum(['confirmed', 'needs_input'])

const textFieldSchema = z.object({
  status: fieldStatusSchema,
  text: z.string(),
  evidenceIds: z.array(z.string()).default([]),
})

const listItemSchema = z.object({
  text: z.string(),
  evidenceIds: z.array(z.string()).default([]),
})

const listFieldSchema = z.object({
  status: fieldStatusSchema,
  items: z.array(listItemSchema).default([]),
  evidenceIds: z.array(z.string()).default([]),
})

const decisionItemSchema = z.object({
  decision: z.string(),
  rationale: z.string(),
  evidenceIds: z.array(z.string()).default([]),
})

const decisionFieldSchema = z.object({
  status: fieldStatusSchema,
  items: z.array(decisionItemSchema).default([]),
  evidenceIds: z.array(z.string()).default([]),
})

export type FieldStatus = z.infer<typeof fieldStatusSchema>

export interface SnapshotView {
  recoveryStatus: ProgressRecoveryStatus
  currentPosition: z.infer<typeof textFieldSchema>
  completedItems: z.infer<typeof listFieldSchema>
  nextActions: z.infer<typeof listFieldSchema>
  importantDecisions: z.infer<typeof decisionFieldSchema>
  /** 全 field を通じて参照される evidence ID の集合 */
  evidenceIds: string[]
}

export interface LatestProgress {
  snapshot: ProgressSnapshotRecord
  view: SnapshotView
}

/**
 * dashboard/detail が採用する最新 snapshot とその展開 view を返す。
 * DESIGN.md: `commits.detected_at DESC, progress_snapshots.created_at DESC` の先頭。
 * 形式不正 snapshot は null (整合性 error は呼び出し側で扱う)。
 */
export function getLatestProgress(db: Db, projectId: string): LatestProgress | null {
  const snapshot = getLatestSnapshotByProject(db, projectId)
  if (snapshot === null) {
    return null
  }
  const view = readSnapshotView(snapshot)
  return view === null ? null : { snapshot, view }
}

/** snapshot の 4 JSON field を検証済み構造へ展開する。形式不正なら null。 */
export function readSnapshotView(snapshot: ProgressSnapshotRecord): SnapshotView | null {
  const currentPosition = textFieldSchema.safeParse(snapshot.currentPosition)
  const completedItems = listFieldSchema.safeParse(snapshot.completedItems)
  const nextActions = listFieldSchema.safeParse(snapshot.nextActions)
  const importantDecisions = decisionFieldSchema.safeParse(snapshot.decisions)
  if (
    !currentPosition.success ||
    !completedItems.success ||
    !nextActions.success ||
    !importantDecisions.success
  ) {
    return null
  }

  const ids = new Set<string>()
  for (const id of currentPosition.data.evidenceIds) {
    ids.add(id)
  }
  for (const field of [completedItems.data, nextActions.data, importantDecisions.data]) {
    for (const id of field.evidenceIds) {
      ids.add(id)
    }
    for (const item of field.items) {
      for (const id of item.evidenceIds) {
        ids.add(id)
      }
    }
  }

  return {
    recoveryStatus: snapshot.recoveryStatus,
    currentPosition: currentPosition.data,
    completedItems: completedItems.data,
    nextActions: nextActions.data,
    importantDecisions: importantDecisions.data,
    evidenceIds: [...ids],
  }
}

interface EvidenceRow {
  id: string
  kind: string
  external_key: string
  title: string
  url: string | null
}

export interface ResolvedEvidence {
  byId: Map<string, EvidenceRef>
  missing: string[]
}

/** evidence ID を当該 project の evidence 行へ解決する。他 project の行は解決しない。 */
export function resolveEvidence(db: Db, projectId: string, ids: string[]): ResolvedEvidence {
  const byId = new Map<string, EvidenceRef>()
  if (ids.length === 0) {
    return { byId, missing: [] }
  }
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT id, kind, external_key, title, url FROM evidence
       WHERE project_id = ? AND id IN (${placeholders})`,
    )
    .all(projectId, ...ids) as EvidenceRow[]
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      kind: row.kind as EvidenceRef['kind'],
      externalKey: row.external_key,
      title: row.title,
      url: row.url,
    })
  }
  return { byId, missing: ids.filter((id) => !byId.has(id)) }
}

export interface NewEvidence {
  projectId: string
  kind: EvidenceKind
  externalKey: string
  sourceVersion: string
  title: string
  url: string | null
  payload: unknown
  capturedAt: string
}

/** (project_id, kind, external_key, source_version) 単位で upsert し、evidence ID を返す。 */
export function upsertEvidence(db: Db, evidence: NewEvidence): string {
  const upsert = db.transaction((): string => {
    const existing = db
      .prepare(
        'SELECT id FROM evidence WHERE project_id = ? AND kind = ? AND external_key = ? AND source_version = ?',
      )
      .get(evidence.projectId, evidence.kind, evidence.externalKey, evidence.sourceVersion) as
      | { id: string }
      | undefined
    const payloadJson = JSON.stringify(evidence.payload)
    if (existing !== undefined) {
      db.prepare(
        'UPDATE evidence SET title = ?, url = ?, payload_json = ?, captured_at = ? WHERE id = ?',
      ).run(evidence.title, evidence.url, payloadJson, evidence.capturedAt, existing.id)
      return existing.id
    }
    const id = randomUUID()
    db.prepare(
      `INSERT INTO evidence (id, project_id, kind, external_key, source_version, title, url, payload_json, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      evidence.projectId,
      evidence.kind,
      evidence.externalKey,
      evidence.sourceVersion,
      evidence.title,
      evidence.url,
      payloadJson,
      evidence.capturedAt,
    )
    return id
  })
  return upsert()
}

/** 当該 run で使う evidence だけを run_evidence へ紐付ける (重複は無視)。 */
export function linkRunEvidence(db: Db, runId: string, evidenceIds: readonly string[]): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO run_evidence (run_id, evidence_id) VALUES (?, ?)',
  )
  const link = db.transaction((ids: readonly string[]): void => {
    for (const id of ids) {
      insert.run(runId, id)
    }
  })
  link(evidenceIds)
}

export function countRunEvidence(db: Db, runId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM run_evidence WHERE run_id = ?')
    .get(runId) as { count: number }
  return row.count
}

export function listRunEvidencePayloads(db: Db, runId: string): unknown[] {
  const rows = db
    .prepare(
      `SELECT e.payload_json AS payload_json FROM run_evidence re
       JOIN evidence e ON e.id = re.evidence_id
       WHERE re.run_id = ?`,
    )
    .all(runId) as Array<{ payload_json: string }>
  return rows.map((row) => JSON.parse(row.payload_json))
}

export interface SnapshotHistoryPage {
  items: ProgressSnapshotRecord[]
  nextCursor: string | null
}

/** cursor は `created_at|id` の複合。同一 created_at でも安定して次ページへ進める。 */
export function historyCursor(snapshot: ProgressSnapshotRecord): string {
  return `${snapshot.createdAt}|${snapshot.id}`
}

/**
 * 進捗履歴を newest-first で返す (DESIGN D018)。
 * `before` は同じ形式の cursor で、それより古い snapshot だけを返す。
 */
export function listSnapshotHistory(
  db: Db,
  projectId: string,
  limit: number,
  before: string | null,
): SnapshotHistoryPage {
  const [beforeCreatedAt, beforeId] = (before ?? '').split('|')
  const rows = (
    before === null
      ? db
          .prepare(
            `SELECT ${SELECT_COLUMNS} FROM progress_snapshots
             WHERE project_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(projectId, limit + 1)
      : db
          .prepare(
            `SELECT ${SELECT_COLUMNS} FROM progress_snapshots
             WHERE project_id = ?
               AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(projectId, beforeCreatedAt, beforeCreatedAt, beforeId, limit + 1)
  ) as ProgressSnapshotRow[]

  const page = rows.slice(0, limit).map(rowToSnapshot)
  const last = page.at(-1)
  return {
    items: page,
    nextCursor: rows.length > limit && last !== undefined ? historyCursor(last) : null,
  }
}
