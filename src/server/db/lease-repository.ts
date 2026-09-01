import type { Db } from './connection.js'

/** heartbeatがこの時間より古いleaseはstaleとして再取得可能。 */
export const LEASE_STALE_MS = 180_000

export interface WorkerLease {
  scope: string
  ownerToken: string
  heartbeatAt: string
}

interface LeaseRow {
  scope: string
  owner_token: string
  heartbeat_at: string
}

function rowToLease(row: LeaseRow): WorkerLease {
  return { scope: row.scope, ownerToken: row.owner_token, heartbeatAt: row.heartbeat_at }
}

/**
 * scope単位でleaseを1件だけ取得する。
 * stale leaseは取得前に削除する。既にactive leaseがあればnullを返す。
 */
export function acquireLease(
  db: Db,
  scope: string,
  ownerToken: string,
  now: Date = new Date(),
): WorkerLease | null {
  const staleBefore = new Date(now.getTime() - LEASE_STALE_MS).toISOString()
  const heartbeatAt = now.toISOString()
  const run = db.transaction((): WorkerLease | null => {
    db.prepare('DELETE FROM worker_leases WHERE heartbeat_at < ?').run(staleBefore)
    const existing = db.prepare('SELECT 1 FROM worker_leases WHERE scope = ?').get(scope)
    if (existing !== undefined) {
      return null
    }
    db.prepare('INSERT INTO worker_leases (scope, owner_token, heartbeat_at) VALUES (?, ?, ?)').run(
      scope,
      ownerToken,
      heartbeatAt,
    )
    return { scope, ownerToken, heartbeatAt }
  })
  return run()
}

/** owner tokenが一致する場合だけheartbeatを更新する。更新できたらtrue。 */
export function heartbeatLease(
  db: Db,
  scope: string,
  ownerToken: string,
  now: Date = new Date(),
): boolean {
  const result = db
    .prepare('UPDATE worker_leases SET heartbeat_at = ? WHERE scope = ? AND owner_token = ?')
    .run(now.toISOString(), scope, ownerToken)
  return result.changes === 1
}

/** owner tokenが一致する場合だけleaseを解放する。解放できたらtrue。 */
export function releaseLease(db: Db, scope: string, ownerToken: string): boolean {
  const result = db
    .prepare('DELETE FROM worker_leases WHERE scope = ? AND owner_token = ?')
    .run(scope, ownerToken)
  return result.changes === 1
}

export function getLease(db: Db, scope: string): WorkerLease | null {
  const row = db
    .prepare('SELECT scope, owner_token, heartbeat_at FROM worker_leases WHERE scope = ?')
    .get(scope) as LeaseRow | undefined
  return row === undefined ? null : rowToLease(row)
}
