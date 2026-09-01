import {
  type BackupRunRecord,
  claimNextQueuedBackupRun,
  hasQueuedBackupRuns,
  markBackupRunTerminal,
} from '../server/db/backup-repository.js'
import type { Db } from '../server/db/connection.js'
import { getLease, heartbeatLease, releaseLease } from '../server/db/lease-repository.js'
import { BACKUP_SCOPE, runBackup } from '../server/services/backup-service.js'

export interface ProcessBackupQueueOptions {
  process?: (db: Db, run: BackupRunRecord) => Promise<void>
  now?: () => Date
  maxIterations?: number
}

/**
 * global `backup` lease を検証し、queued backup run を queued_at 昇順で 1 件ずつ処理する。
 * queue が空になった transaction 内でのみ owner token 一致 release する。
 */
export async function processBackupQueue(
  db: Db,
  ownerToken: string,
  options: ProcessBackupQueueOptions = {},
): Promise<void> {
  if (getLease(db, BACKUP_SCOPE)?.ownerToken !== ownerToken) {
    return
  }

  const handler = options.process ?? ((d, run) => runBackup(d, run))
  const now = options.now ?? (() => new Date())
  const limit = options.maxIterations ?? Number.POSITIVE_INFINITY

  for (let iteration = 0; iteration < limit; iteration += 1) {
    heartbeatLease(db, BACKUP_SCOPE, ownerToken, now())

    const run = claimNextQueuedBackupRun(db, now())
    if (run === null) {
      const released = db.transaction((): boolean => {
        if (hasQueuedBackupRuns(db)) {
          return false
        }
        releaseLease(db, BACKUP_SCOPE, ownerToken)
        return true
      })()
      if (released) {
        return
      }
      continue
    }

    try {
      await handler(db, run)
    } catch (error) {
      markBackupRunTerminal(db, run.id, 'failed', {
        errorCode: 'BACKUP_FAILED',
        errorMessage: String(error).slice(0, 500),
      })
    }
  }
}
