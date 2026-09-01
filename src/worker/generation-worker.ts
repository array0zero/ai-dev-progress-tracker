import type { Db } from '../server/db/connection.js'
import { getLease, heartbeatLease, releaseLease } from '../server/db/lease-repository.js'
import {
  claimNextQueuedGenerationRun,
  type GenerationRunRecord,
  hasQueuedGenerationRuns,
  markRunFailed,
} from '../server/db/run-repository.js'
import { generationScope, runGeneration } from '../server/services/generation-service.js'

export interface ProcessQueueOptions {
  /** run 1 件の処理。既定は generation-service.runGeneration。 */
  process?: (db: Db, run: GenerationRunRecord) => Promise<void>
  now?: () => Date
  /** テスト用の安全弁。既定は無制限。 */
  maxIterations?: number
}

function projectIdFromScope(scope: string): string {
  const prefix = generationScope('')
  return scope.startsWith(prefix) ? scope.slice(prefix.length) : scope
}

/**
 * lease token を検証したうえで、queued run を enqueue 順に 1 件ずつ running へ遷移して処理する。
 * queue が空になった transaction 内でのみ owner token 一致 release を行う。
 */
export async function processGenerationQueue(
  db: Db,
  scope: string,
  ownerToken: string,
  options: ProcessQueueOptions = {},
): Promise<void> {
  if (getLease(db, scope)?.ownerToken !== ownerToken) {
    return
  }

  const handler = options.process ?? runGeneration
  const now = options.now ?? (() => new Date())
  const projectId = projectIdFromScope(scope)
  const limit = options.maxIterations ?? Number.POSITIVE_INFINITY

  for (let iteration = 0; iteration < limit; iteration += 1) {
    heartbeatLease(db, scope, ownerToken, now())

    const run = claimNextQueuedGenerationRun(db, projectId, now())
    if (run === null) {
      const released = db.transaction((): boolean => {
        if (hasQueuedGenerationRuns(db, projectId)) {
          return false
        }
        releaseLease(db, scope, ownerToken)
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
      markRunFailed(db, run.id, 'GENERATION_FAILED', String(error).slice(0, 500), now())
    }
  }
}
