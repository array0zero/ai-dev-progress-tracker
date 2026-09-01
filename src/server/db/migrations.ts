import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Db } from './connection.js'

interface Migration {
  readonly version: number
  readonly file: string
}

const MIGRATIONS: readonly Migration[] = [{ version: 1, file: '001_init.sql' }]

function readMigrationSql(file: string): string {
  const url = new URL(`../../../db/migrations/${file}`, import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf8')
}

/**
 * 未適用のmigrationだけをversion順に適用する。
 * 001_init.sql自身がschema_migrationsへversion行をINSERTするため、
 * 適用済みかどうかは同テーブルの存在を作ったうえでversionで判定する。
 */
export function runMigrations(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;',
  )
  const hasVersion = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
  for (const migration of MIGRATIONS) {
    if (hasVersion.get(migration.version) !== undefined) {
      continue
    }
    db.exec(readMigrationSql(migration.file))
  }
}
