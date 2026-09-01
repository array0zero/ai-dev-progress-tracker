import { createHash } from 'node:crypto'
import {
  createPrivateRepo,
  ensureAuthSetupGit,
  getActiveLogin,
  viewRepo,
} from '../adapters/github.js'
import type { Db } from '../db/connection.js'
import {
  BACKUP_APP_ID,
  BACKUP_SCHEMA_VERSION,
  BACKUP_TABLES,
  type BackupCounts,
  type BackupManifest,
} from '../schemas/backup.js'
import { containsHighConfidenceSecret } from '../security/redaction.js'

export const BACKUP_REPO_SUFFIX = 'ai-dev-progress-tracker-backup'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * DESIGN.md「バックアップファイル」の data 部を deterministic に生成する。
 * backup_runs / worker_leases / log / env は含めない。
 * 各テーブルは PK 昇順、UTF-8・2-space indent・末尾 LF。
 */
export function exportBackupData(db: Db): { dataJson: string; counts: BackupCounts } {
  const data: Record<string, unknown[]> = {}
  const counts: Record<string, number> = {}
  for (const { key, table, orderBy } of BACKUP_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as Record<
      string,
      unknown
    >[]
    data[key] = rows
    counts[key] = rows.length
  }
  return {
    dataJson: `${JSON.stringify(data, null, 2)}\n`,
    counts: counts as BackupCounts,
  }
}

export function buildBackupManifest(
  dataJson: string,
  counts: BackupCounts,
  now: Date,
): { manifest: BackupManifest; manifestJson: string } {
  const manifest: BackupManifest = {
    appId: BACKUP_APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    sha256: sha256Hex(dataJson),
    counts,
  }
  return { manifest, manifestJson: `${JSON.stringify(manifest, null, 2)}\n` }
}

export type BackupExportResult =
  | {
      ok: true
      dataJson: string
      manifestJson: string
      manifest: BackupManifest
      counts: BackupCounts
    }
  | { ok: false; code: 'SECRET_DETECTED' }

/** DB から backup export 一式を作る。export 文字列へ high-confidence scanner を再適用する。 */
export function createBackupExport(db: Db, now: Date = new Date()): BackupExportResult {
  const { dataJson, counts } = exportBackupData(db)
  if (containsHighConfidenceSecret(dataJson)) {
    return { ok: false, code: 'SECRET_DETECTED' }
  }
  const { manifest, manifestJson } = buildBackupManifest(dataJson, counts, now)
  return { ok: true, dataJson, manifestJson, manifest, counts }
}

export interface EnsureBackupRepoDeps {
  getActiveLogin: typeof getActiveLogin
  viewRepo: typeof viewRepo
  createPrivateRepo: typeof createPrivateRepo
  ensureAuthSetupGit: typeof ensureAuthSetupGit
}

const DEFAULT_ENSURE_DEPS: EnsureBackupRepoDeps = {
  getActiveLogin,
  viewRepo,
  createPrivateRepo,
  ensureAuthSetupGit,
}

export type EnsureBackupRepoResult =
  | { ok: true; slug: string; created: boolean }
  | { ok: false; code: string }

/**
 * `<gh active user>/ai-dev-progress-tracker-backup` を ensure する。
 * 既存なら visibility=PRIVATE を要求。なければ Private 作成。ensure 時に `gh auth setup-git`。
 * marker (manifest.json の appId) 検証は local clone を持つ T014 で行う。
 */
export async function ensureBackupRepo(
  deps: EnsureBackupRepoDeps = DEFAULT_ENSURE_DEPS,
): Promise<EnsureBackupRepoResult> {
  const login = await deps.getActiveLogin()
  if (login === null) {
    return { ok: false, code: 'GITHUB_AUTH_REQUIRED' }
  }
  const slug = `${login}/${BACKUP_REPO_SUFFIX}`

  const view = await deps.viewRepo(slug)
  if (view.ok) {
    if (view.repo.visibility.toUpperCase() !== 'PRIVATE') {
      return { ok: false, code: 'BACKUP_REPO_NOT_PRIVATE' }
    }
    await deps.ensureAuthSetupGit()
    return { ok: true, slug, created: false }
  }

  const created = await deps.createPrivateRepo(slug)
  if (!created) {
    return { ok: false, code: 'BACKUP_REPO_CREATE_FAILED' }
  }
  await deps.ensureAuthSetupGit()
  return { ok: true, slug, created: true }
}
