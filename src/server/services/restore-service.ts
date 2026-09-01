import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inspectRepository } from '../adapters/git.js'
import { runProcess } from '../adapters/process-runner.js'
import type { AppConfig } from '../config.js'
import { openDatabase } from '../db/connection.js'
import { LATEST_MIGRATION_VERSION } from '../db/migrations.js'
import { listProjects, updateProjectStatus } from '../db/project-repository.js'
import {
  BACKUP_TABLES,
  type BackupData,
  type BackupManifest,
  backupDataSchema,
  backupManifestSchema,
} from '../schemas/backup.js'
import { type EnsureBackupRepoResult, ensureBackupRepo } from './backup-service.js'
import { installHooks } from './hook-service.js'

export type RestoreResult =
  | { ok: true; tempDbPath: string; manifest: BackupManifest }
  | { ok: false; code: string; reason: string }

function fail(code: string, reason: string): RestoreResult {
  return { ok: false, code, reason }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function removeTempDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      rmSync(`${path}${suffix}`, { force: true })
    } catch {
      // best effort
    }
  }
}

/**
 * DESIGN.md「Restore」の core。既存 tracker.db には一切触れず、
 * `tempDbPath` へ検証済みの新規 SQLite を構築する。
 * manifest/checksum/schema/FK/件数のいずれかが不正なら temp DB を削除して失敗を返す。
 */
export function restoreFromBackup(
  dataJson: string,
  manifestJson: string,
  tempDbPath: string,
): RestoreResult {
  // 1. manifest
  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(manifestJson)
  } catch {
    return fail('BACKUP_MANIFEST_INVALID', 'manifest.json is not valid JSON')
  }
  const manifestParsed = backupManifestSchema.safeParse(manifestRaw)
  if (!manifestParsed.success) {
    return fail('BACKUP_MANIFEST_INVALID', manifestParsed.error.message.slice(0, 300))
  }
  const manifest = manifestParsed.data
  if (manifest.schemaVersion !== LATEST_MIGRATION_VERSION) {
    return fail(
      'BACKUP_SCHEMA_VERSION_MISMATCH',
      `manifest schemaVersion ${manifest.schemaVersion} != ${LATEST_MIGRATION_VERSION}`,
    )
  }

  // 2. checksum
  if (sha256Hex(dataJson) !== manifest.sha256) {
    return fail('BACKUP_CHECKSUM_MISMATCH', 'data SHA-256 does not match the manifest')
  }

  // 3. data schema
  let dataRaw: unknown
  try {
    dataRaw = JSON.parse(dataJson)
  } catch {
    return fail('BACKUP_DATA_INVALID', 'backup-v1.json is not valid JSON')
  }
  const dataParsed = backupDataSchema.safeParse(dataRaw)
  if (!dataParsed.success) {
    return fail('BACKUP_DATA_INVALID', dataParsed.error.message.slice(0, 300))
  }
  const data: BackupData = dataParsed.data

  // 4. temp SQLite へ migration + import
  if (existsSync(tempDbPath)) {
    removeTempDb(tempDbPath)
  }
  const db = openDatabase(tempDbPath)
  try {
    // import 中は FK を切り、投入後に foreign_key_check で一括検証する。
    db.pragma('foreign_keys = OFF')
    const importAll = db.transaction((): void => {
      for (const { key, table, columns } of BACKUP_TABLES) {
        const rows = data[key] as ReadonlyArray<Record<string, unknown>>
        if (rows.length === 0) {
          continue
        }
        const placeholders = columns.map(() => '?').join(', ')
        const stmt = db.prepare(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
        )
        for (const row of rows) {
          stmt.run(...columns.map((col) => row[col] ?? null))
        }
      }
    })
    importAll()

    // 5. FK 整合性
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
    if (fkViolations.length > 0) {
      return failAndCleanup(db, tempDbPath, 'BACKUP_FK_VIOLATION', 'foreign_key_check found rows')
    }

    // 6. 件数一致
    for (const { key, table } of BACKUP_TABLES) {
      const actual = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
      const expected = manifest.counts[key]
      if (actual !== expected) {
        return failAndCleanup(
          db,
          tempDbPath,
          'BACKUP_COUNT_MISMATCH',
          `${table}: imported ${actual} != manifest ${expected}`,
        )
      }
    }

    db.close()
    return { ok: true, tempDbPath, manifest }
  } catch (error) {
    return failAndCleanup(
      db,
      tempDbPath,
      'BACKUP_IMPORT_FAILED',
      error instanceof Error ? error.message.slice(0, 300) : 'import failed',
    )
  }
}

function failAndCleanup(
  db: ReturnType<typeof openDatabase>,
  tempDbPath: string,
  code: string,
  reason: string,
): RestoreResult {
  try {
    db.close()
  } catch {
    // ignore
  }
  removeTempDb(tempDbPath)
  return fail(code, reason)
}

// --- full restore orchestration (T016) --------------------------------------

function timestampSuffix(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

export interface PerformRestoreOptions {
  force?: boolean
  now?: () => Date
  ensureRepo?: () => Promise<EnsureBackupRepoResult>
  repoUrlFor?: (slug: string) => string
  /** cloneDir へ manifest.json + data/backup-v1.json を用意する (既定は git clone / pull --ff-only)。 */
  syncClone?: (repoUrl: string, cloneDir: string) => Promise<boolean>
  installHooks?: typeof installHooks
  inspectRepository?: typeof inspectRepository
}

export interface PerformRestoreResult {
  ok: boolean
  exitCode: number
  code?: string
  reason?: string
  restoredProjects?: number
  reinstalledHooks?: string[]
  localMissing?: string[]
  preRestorePath?: string | null
}

async function defaultSyncClone(repoUrl: string, cloneDir: string): Promise<boolean> {
  if (existsSync(join(cloneDir, '.git'))) {
    const pull = await runProcess('git', ['-C', cloneDir, 'pull', '--ff-only'], {
      timeoutMs: 60_000,
    })
    if (pull.timedOut || pull.code !== 0) {
      return false
    }
    // `.gitattributes` (改行変換の無効化) が後から入った場合に備え、追跡ファイルを
    // 現在の属性で再展開する。これで backup-v1.json が CRLF に化けた古い clone でも
    // checksum が一致する。best-effort。
    await runProcess('git', ['-C', cloneDir, 'checkout', 'HEAD', '--', '.'], { timeoutMs: 60_000 })
    return true
  }
  const clone = await runProcess('git', ['clone', repoUrl, cloneDir], { timeoutMs: 120_000 })
  return !clone.timedOut && clone.code === 0
}

/**
 * DESIGN.md「Restore CLI」: backup repo を同期 → 検証済み temp DB を作成 →
 * (既存DBは --force 時のみ退避して) atomic rename で tracker.db を置換 →
 * local_path が存在し repo identity 一致の project へ hook 再設置、それ以外は local_missing。
 * 既存DBありで --force なしは exitCode 2。
 */
export async function performRestore(
  config: AppConfig,
  options: PerformRestoreOptions = {},
): Promise<PerformRestoreResult> {
  const now = options.now ?? (() => new Date())
  const ensure = options.ensureRepo ?? (() => ensureBackupRepo())
  const repoUrlFor = options.repoUrlFor ?? ((slug: string) => `https://github.com/${slug}.git`)
  const syncClone = options.syncClone ?? defaultSyncClone
  const hooks = options.installHooks ?? installHooks
  const inspect = options.inspectRepository ?? inspectRepository

  const cloneDir = join(config.dataDir, 'backup-repo')
  const repo = await ensure()
  if (!repo.ok) {
    return {
      ok: false,
      exitCode: 1,
      code: repo.code,
      reason: 'Backup repository is not available.',
    }
  }

  mkdirSync(dirname(cloneDir), { recursive: true })
  if (!(await syncClone(repoUrlFor(repo.slug), cloneDir))) {
    return {
      ok: false,
      exitCode: 1,
      code: 'BACKUP_CLONE_FAILED',
      reason: 'Could not sync the backup clone.',
    }
  }

  const manifestPath = join(cloneDir, 'manifest.json')
  const dataPath = join(cloneDir, 'data', 'backup-v1.json')
  if (!existsSync(manifestPath) || !existsSync(dataPath)) {
    return {
      ok: false,
      exitCode: 1,
      code: 'BACKUP_FILES_MISSING',
      reason: 'manifest.json / data missing.',
    }
  }

  const dbExists = existsSync(config.dbPath)
  if (dbExists && options.force !== true) {
    return {
      ok: false,
      exitCode: 2,
      code: 'DB_EXISTS',
      reason: 'An existing tracker.db was found. Re-run with --force to overwrite.',
    }
  }

  const suffix = timestampSuffix(now())
  const tempPath = `${config.dbPath}.restore-${suffix}`
  const restored = restoreFromBackup(
    readFileSync(dataPath, 'utf8'),
    readFileSync(manifestPath, 'utf8'),
    tempPath,
  )
  if (!restored.ok) {
    return { ok: false, exitCode: 1, code: restored.code, reason: restored.reason }
  }

  let preRestorePath: string | null = null
  if (dbExists) {
    preRestorePath = `${config.dbPath}.pre-restore-${suffix}`
    renameSync(config.dbPath, preRestorePath)
    for (const sidecar of ['-wal', '-shm']) {
      try {
        rmSync(`${config.dbPath}${sidecar}`, { force: true })
      } catch {
        // ignore
      }
    }
  }
  renameSync(tempPath, config.dbPath)

  const db = openDatabase(config.dbPath)
  const reinstalledHooks: string[] = []
  const localMissing: string[] = []
  try {
    const projects = listProjects(db)
    for (const project of projects) {
      if (!existsSync(project.localPath)) {
        updateProjectStatus(db, project.id, 'local_missing', now())
        localMissing.push(project.id)
        continue
      }
      const inspection = await inspect(
        project.localPath,
        `${project.repoOwner}/${project.repoName}`,
      )
      if (inspection.ok) {
        await hooks(inspection.layout.gitDir, project.id)
        if (project.status !== 'active') {
          updateProjectStatus(db, project.id, 'active', now())
        }
        reinstalledHooks.push(project.id)
      } else {
        updateProjectStatus(db, project.id, 'local_missing', now())
        localMissing.push(project.id)
      }
    }
    return {
      ok: true,
      exitCode: 0,
      restoredProjects: projects.length,
      reinstalledHooks,
      localMissing,
      preRestorePath,
    }
  } finally {
    db.close()
  }
}
