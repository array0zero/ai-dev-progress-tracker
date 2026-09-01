import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireLease,
  getLease,
  heartbeatLease,
  releaseLease,
} from '../../src/server/db/lease-repository.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

describe('lease-repository', () => {
  let ctx: TestDb

  beforeEach(() => {
    ctx = createTestDb()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('grants a scope lease to the first caller only', () => {
    expect(acquireLease(ctx.db, 'backup', 'token-a')).not.toBeNull()
    expect(acquireLease(ctx.db, 'backup', 'token-b')).toBeNull()
    expect(getLease(ctx.db, 'backup')?.ownerToken).toBe('token-a')
  })

  it('grants different scopes independently', () => {
    expect(acquireLease(ctx.db, 'generation:p1', 't1')).not.toBeNull()
    expect(acquireLease(ctx.db, 'generation:p2', 't2')).not.toBeNull()
  })

  it('refuses release and heartbeat when the owner token does not match', () => {
    acquireLease(ctx.db, 'backup', 'token-a')

    expect(releaseLease(ctx.db, 'backup', 'wrong')).toBe(false)
    expect(heartbeatLease(ctx.db, 'backup', 'wrong')).toBe(false)
    expect(getLease(ctx.db, 'backup')).not.toBeNull()

    expect(releaseLease(ctx.db, 'backup', 'token-a')).toBe(true)
    expect(getLease(ctx.db, 'backup')).toBeNull()
  })

  it('updates heartbeat only for the owning token', () => {
    const acquiredAt = new Date('2026-09-01T00:00:00.000Z')
    acquireLease(ctx.db, 'backup', 'token-a', acquiredAt)

    const beatAt = new Date('2026-09-01T00:02:30.000Z')
    expect(heartbeatLease(ctx.db, 'backup', 'token-a', beatAt)).toBe(true)
    expect(getLease(ctx.db, 'backup')?.heartbeatAt).toBe(beatAt.toISOString())
  })

  it('reclaims a lease whose heartbeat is older than 180s', () => {
    const start = new Date('2026-09-01T00:00:00.000Z')
    acquireLease(ctx.db, 'backup', 'stale-owner', start)

    const justUnder = new Date(start.getTime() + 179_000)
    expect(acquireLease(ctx.db, 'backup', 'new-owner', justUnder)).toBeNull()

    const justOver = new Date(start.getTime() + 181_000)
    expect(acquireLease(ctx.db, 'backup', 'new-owner', justOver)?.ownerToken).toBe('new-owner')
  })
})
