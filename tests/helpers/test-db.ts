import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { type Db, openDatabase } from '../../src/server/db/connection.js'

export interface TestDb {
  db: Db
  path: string
  cleanup: () => void
}

/** 一時ディレクトリへ実ファイルのSQLiteを作る。cleanup()で接続を閉じてディレクトリごと削除する。 */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'adpt-test-'))
  const path = join(dir, 'tracker.db')
  const db = openDatabase(path)
  return {
    db,
    path,
    cleanup: () => {
      if (db.open) {
        db.close()
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * migration 001 だけを適用した v1 相当の DB を作る。
 * v1 DB を v2 へ上げる経路 (002 の追加適用 / pre-v2 copy) を検証するために使う。
 */
export function createV1TestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'adpt-v1-'))
  const path = join(dir, 'tracker.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;',
  )
  db.exec(readFileSync(join(process.cwd(), 'db/migrations/001_init.sql'), 'utf8'))
  return {
    db,
    path,
    cleanup: () => {
      if (db.open) {
        db.close()
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
