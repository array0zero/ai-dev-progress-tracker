import { listCandidates } from '../server/db/candidate-repository.js'
import type { Db } from '../server/db/connection.js'
import {
  type RegistrationDeps,
  runRegistrationCycle,
} from '../server/services/registration-service.js'

/**
 * `registering` の candidate を古い順に 1 件ずつ登録する。
 * candidate の status 自体が排他になるので worker lease は使わない。
 */
export async function processRegistrationQueue(db: Db, deps: RegistrationDeps = {}): Promise<void> {
  const queued = listCandidates(db, 'registering').sort((a, b) =>
    a.lastSeenAt < b.lastSeenAt ? -1 : a.lastSeenAt > b.lastSeenAt ? 1 : 0,
  )
  for (const candidate of queued) {
    await runRegistrationCycle(db, candidate.id, deps)
  }
}
