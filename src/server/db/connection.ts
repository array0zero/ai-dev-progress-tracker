import BetterSqlite3 from 'better-sqlite3'
import { runMigrations } from './migrations.js'

export type Db = BetterSqlite3.Database

/**
 * SQLite接続を開き、v1 migrationを一度だけ適用して返す。
 * WAL / foreign_keys / synchronous FULL はここで有効化する。
 */
export function openDatabase(dbPath: string): Db {
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = FULL')
  runMigrations(db)
  return db
}
