import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { openDatabase } from '../db/connection.js'
import { LATEST_MIGRATION_VERSION } from '../db/migrations.js'
import {
  BACKUP_TABLES,
  type BackupData,
  type BackupManifest,
  backupDataSchema,
  backupManifestSchema,
} from '../schemas/backup.js'

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
