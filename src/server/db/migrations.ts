import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Db } from './connection.js'

interface Migration {
  readonly version: number
  readonly file: string
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, file: '001_init.sql' },
  { version: 2, file: '002_v2.sql' },
]

/**
 * restore が受け付ける backup manifest の schemaVersion。
 * DB schema の最新は `MIGRATIONS` 末尾 (v2) だが、production export は現状 v1 形式のまま。
 * v1/v2 両対応は T016 で分岐させる。
 */
export const LATEST_MIGRATION_VERSION = 1

function readMigrationSql(file: string): string {
  const url = new URL(`../../../db/migrations/${file}`, import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf8')
}

/** ファイル名に使えない `:` を避けた UTC timestamp。 */
function fileTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

/**
 * v1 DB を v2 へ上げる前に 1 copy 残す (DESIGN「DB upgrade」)。自動削除しない。
 * WAL を畳んでから copy するので、copy 単体で v1 app が開ける。
 */
function copyPreV2Database(db: Db, now: Date): void {
  const source = db.name
  if (source === '' || source === ':memory:' || !existsSync(source)) {
    return
  }
  db.pragma('wal_checkpoint(TRUNCATE)')
  copyFileSync(source, `${source}.pre-v2-${fileTimestamp(now)}`)
}

/**
 * 未適用のmigrationだけをversion順に適用する。
 * 001_init.sql自身がschema_migrationsへversion行をINSERTするため、
 * 適用済みかどうかは同テーブルの存在を作ったうえでversionで判定する。
 */
export function runMigrations(db: Db, now: Date = new Date()): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;',
  )
  const hasVersion = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
  const hadV1BeforeThisRun = hasVersion.get(1) !== undefined
  for (const migration of MIGRATIONS) {
    if (hasVersion.get(migration.version) !== undefined) {
      continue
    }
    if (migration.version === 2 && hadV1BeforeThisRun) {
      copyPreV2Database(db, now)
    }
    db.exec(readMigrationSql(migration.file))
  }
}
