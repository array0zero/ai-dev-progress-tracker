import { z } from 'zod'

const nullableString = z.string().nullable()

const projectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  local_path: z.string(),
  repo_node_id: z.string(),
  repo_owner: z.string(),
  repo_name: z.string(),
  repo_url: z.string(),
  default_branch: z.string(),
  status: z.enum(['active', 'local_missing']),
  created_at: z.string(),
  updated_at: z.string(),
})

const commitRowSchema = z.object({
  project_id: z.string(),
  sha: z.string(),
  parent_sha: nullableString,
  message: z.string(),
  authored_at: z.string(),
  detected_at: z.string(),
})

const evidenceRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  kind: z.enum(['commit', 'issue', 'pull_request']),
  external_key: z.string(),
  source_version: z.string(),
  title: z.string(),
  url: nullableString,
  payload_json: z.string(),
  captured_at: z.string(),
})

const generationRunRowSchema = z.object({
  id: z.string(),
  dedupe_key: z.string(),
  project_id: z.string(),
  commit_sha: z.string(),
  mode: z.enum(['generation', 'recovery']),
  trigger: z.enum(['post_commit', 'registration', 'manual_recovery']),
  status: z.enum(['queued', 'running', 'succeeded', 'partial', 'unrecoverable', 'failed']),
  detected_at: z.string(),
  started_at: nullableString,
  finished_at: nullableString,
  ai_provider: z.string(),
  ai_cli_version: nullableString,
  ai_model: z.string(),
  error_code: nullableString,
  error_message: nullableString,
})

const runEvidenceRowSchema = z.object({
  run_id: z.string(),
  evidence_id: z.string(),
})

const progressSnapshotRowSchema = z.object({
  id: z.string(),
  generation_run_id: z.string(),
  project_id: z.string(),
  commit_sha: z.string(),
  recovery_status: z.enum(['complete', 'partial', 'unrecoverable']),
  current_position_json: z.string(),
  completed_items_json: z.string(),
  next_actions_json: z.string(),
  decisions_json: z.string(),
  created_at: z.string(),
})

/** DESIGN.md「バックアップファイル」の data 部 (backup-v1.json)。 */
export const backupDataSchema = z.object({
  projects: z.array(projectRowSchema),
  commits: z.array(commitRowSchema),
  evidence: z.array(evidenceRowSchema),
  generationRuns: z.array(generationRunRowSchema),
  runEvidence: z.array(runEvidenceRowSchema),
  progressSnapshots: z.array(progressSnapshotRowSchema),
})

export type BackupData = z.infer<typeof backupDataSchema>

/**
 * data 部の各テーブル (top-level key)。
 * export は下記の順、import (restore) も FK-safe なこの順で行う。
 * `columns` は INSERT の列順 = DDL の列順。
 */
export const BACKUP_TABLES = [
  {
    key: 'projects',
    table: 'projects',
    orderBy: 'id',
    columns: [
      'id',
      'name',
      'local_path',
      'repo_node_id',
      'repo_owner',
      'repo_name',
      'repo_url',
      'default_branch',
      'status',
      'created_at',
      'updated_at',
    ],
  },
  {
    key: 'commits',
    table: 'commits',
    orderBy: 'project_id, sha',
    columns: ['project_id', 'sha', 'parent_sha', 'message', 'authored_at', 'detected_at'],
  },
  {
    key: 'evidence',
    table: 'evidence',
    orderBy: 'id',
    columns: [
      'id',
      'project_id',
      'kind',
      'external_key',
      'source_version',
      'title',
      'url',
      'payload_json',
      'captured_at',
    ],
  },
  {
    key: 'generationRuns',
    table: 'generation_runs',
    orderBy: 'id',
    columns: [
      'id',
      'dedupe_key',
      'project_id',
      'commit_sha',
      'mode',
      'trigger',
      'status',
      'detected_at',
      'started_at',
      'finished_at',
      'ai_provider',
      'ai_cli_version',
      'ai_model',
      'error_code',
      'error_message',
    ],
  },
  {
    key: 'runEvidence',
    table: 'run_evidence',
    orderBy: 'run_id, evidence_id',
    columns: ['run_id', 'evidence_id'],
  },
  {
    key: 'progressSnapshots',
    table: 'progress_snapshots',
    orderBy: 'id',
    columns: [
      'id',
      'generation_run_id',
      'project_id',
      'commit_sha',
      'recovery_status',
      'current_position_json',
      'completed_items_json',
      'next_actions_json',
      'decisions_json',
      'created_at',
    ],
  },
] as const

export type BackupTableKey = (typeof BACKUP_TABLES)[number]['key']

export const backupCountsSchema = z.object({
  projects: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  evidence: z.number().int().nonnegative(),
  generationRuns: z.number().int().nonnegative(),
  runEvidence: z.number().int().nonnegative(),
  progressSnapshots: z.number().int().nonnegative(),
})

export type BackupCounts = z.infer<typeof backupCountsSchema>

export const BACKUP_APP_ID = 'ai-dev-progress-tracker'
export const BACKUP_SCHEMA_VERSION = 1

export const backupManifestSchema = z.object({
  appId: z.literal(BACKUP_APP_ID),
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
  createdAt: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: backupCountsSchema,
})

export type BackupManifest = z.infer<typeof backupManifestSchema>

// --- v2 (production export) -------------------------------------------------
//
// v1 の schema / ファイルは変更しない。v2 は project の v2 列と
// registration_candidates を追加した上位互換の形として別に定義する。

const projectRowV2Schema = projectRowSchema.extend({
  summary: z.string().max(240),
  registration_source: z.enum(['manual', 'codex', 'claude']),
  review_required: z.union([z.literal(0), z.literal(1)]),
  review_required_at: nullableString,
})

const registrationCandidateRowSchema = z.object({
  id: z.string(),
  local_path: z.string(),
  agent: z.enum(['codex', 'claude']),
  status: z.enum(['detected', 'prompted', 'declined', 'registering', 'failed', 'registered']),
  suggested_name: z.string().min(1).max(120),
  detected_at: z.string(),
  last_seen_at: z.string(),
  prompted_at: nullableString,
  decision_at: nullableString,
  attempt_count: z.number().int().min(0).max(2),
  last_error_code: nullableString,
  last_error_message: nullableString,
  project_id: nullableString,
})

/** `schemas/backup-v2.schema.json` と同義の data 部 (backup-v2.json)。 */
export const backupDataV2Schema = z.object({
  projects: z.array(projectRowV2Schema),
  commits: z.array(commitRowSchema),
  evidence: z.array(evidenceRowSchema),
  generationRuns: z.array(generationRunRowSchema),
  runEvidence: z.array(runEvidenceRowSchema),
  progressSnapshots: z.array(progressSnapshotRowSchema),
  registrationCandidates: z.array(registrationCandidateRowSchema),
})

export type BackupDataV2 = z.infer<typeof backupDataV2Schema>

const PROJECT_COLUMNS_V2 = [
  'id',
  'name',
  'local_path',
  'repo_node_id',
  'repo_owner',
  'repo_name',
  'repo_url',
  'default_branch',
  'status',
  'summary',
  'registration_source',
  'review_required',
  'review_required_at',
  'created_at',
  'updated_at',
] as const

/** v2 export / import のテーブル順。FK-safe なこの順で INSERT する。 */
export const BACKUP_TABLES_V2 = [
  { ...BACKUP_TABLES[0], columns: PROJECT_COLUMNS_V2 },
  ...BACKUP_TABLES.slice(1),
  {
    key: 'registrationCandidates',
    table: 'registration_candidates',
    orderBy: 'id',
    columns: [
      'id',
      'local_path',
      'agent',
      'status',
      'suggested_name',
      'detected_at',
      'last_seen_at',
      'prompted_at',
      'decision_at',
      'attempt_count',
      'last_error_code',
      'last_error_message',
      'project_id',
    ],
  },
] as const satisfies ReadonlyArray<{
  key: string
  table: string
  orderBy: string
  columns: readonly string[]
}>

export const backupCountsV2Schema = backupCountsSchema.extend({
  registrationCandidates: z.number().int().nonnegative(),
})

export type BackupCountsV2 = z.infer<typeof backupCountsV2Schema>

export const BACKUP_SCHEMA_VERSION_V2 = 2

export const backupManifestV2Schema = z.object({
  appId: z.literal(BACKUP_APP_ID),
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION_V2),
  createdAt: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: backupCountsV2Schema,
})

export type BackupManifestV2 = z.infer<typeof backupManifestV2Schema>

export type AnyBackupManifest =
  | { version: 1; manifest: BackupManifest }
  | { version: 2; manifest: BackupManifestV2 }

/** v1 / v2 どちらの manifest かを判定して parse する。restore の入口で使う。 */
export function parseBackupManifest(raw: unknown): AnyBackupManifest | null {
  const v2 = backupManifestV2Schema.safeParse(raw)
  if (v2.success) {
    return { version: 2, manifest: v2.data }
  }
  const v1 = backupManifestSchema.safeParse(raw)
  return v1.success ? { version: 1, manifest: v1.data } : null
}

/** manifest version ごとの data ファイル名。 */
export function backupDataFileName(version: 1 | 2): string {
  return version === 2 ? 'backup-v2.json' : 'backup-v1.json'
}
