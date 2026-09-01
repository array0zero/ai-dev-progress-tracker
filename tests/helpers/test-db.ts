import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
