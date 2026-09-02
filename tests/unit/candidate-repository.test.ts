import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  beginRegistration,
  declineCandidate,
  findCandidateByLocalPath,
  getCandidate,
  listCandidates,
  markPrompted,
  markRegistered,
  recordFailure,
  reopenCandidate,
  upsertDetected,
} from '../../src/server/db/candidate-repository.js'
import { openDatabase } from '../../src/server/db/connection.js'
import { insertProject } from '../../src/server/db/project-repository.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

const PATH_A = 'D:/work/alpha'
const PATH_B = 'D:/work/beta'

function detect(ctx: TestDb, localPath = PATH_A, agent: 'codex' | 'claude' = 'codex') {
  return upsertDetected(
    ctx.db,
    { localPath, agent, suggestedName: localPath.split('/').pop() ?? 'x' },
    new Date('2026-09-02T00:00:00.000Z'),
  )
}

describe('candidate repository', () => {
  let ctx: TestDb

  beforeEach(() => {
    ctx = createTestDb()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('returns an empty list and null lookups on an empty database', () => {
    expect(listCandidates(ctx.db)).toEqual([])
    expect(listCandidates(ctx.db, 'failed')).toEqual([])
    expect(getCandidate(ctx.db, randomUUID())).toBeNull()
    expect(findCandidateByLocalPath(ctx.db, PATH_A)).toBeNull()
  })

  it('creates one candidate per local path and only moves last_seen_at on repeat events', () => {
    const first = detect(ctx)
    expect(first).toMatchObject({
      localPath: PATH_A,
      agent: 'codex',
      status: 'detected',
      suggestedName: 'alpha',
      attemptCount: 0,
      promptedAt: null,
      decisionAt: null,
      projectId: null,
    })

    for (let i = 0; i < 9; i += 1) {
      upsertDetected(
        ctx.db,
        { localPath: PATH_A, agent: 'claude', suggestedName: 'other-name' },
        new Date('2026-09-02T01:00:00.000Z'),
      )
    }

    const candidates = listCandidates(ctx.db)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      id: first.id,
      agent: 'codex',
      suggestedName: 'alpha',
      detectedAt: '2026-09-02T00:00:00.000Z',
      lastSeenAt: '2026-09-02T01:00:00.000Z',
    })
  })

  it('reads back every field after closing and reopening the database', () => {
    const candidate = detect(ctx)
    markPrompted(ctx.db, candidate.id, new Date('2026-09-02T02:00:00.000Z'))
    ctx.db.close()

    const reopened = openDatabase(ctx.path)
    try {
      expect(getCandidate(reopened, candidate.id)).toEqual({
        ...candidate,
        status: 'prompted',
        promptedAt: '2026-09-02T02:00:00.000Z',
      })
    } finally {
      reopened.close()
    }
  })

  it('walks detected -> prompted -> registering -> registered', () => {
    const candidate = detect(ctx)
    const projectId = randomUUID()
    insertProject(ctx.db, {
      id: projectId,
      name: 'alpha',
      localPath: PATH_A,
      repoNodeId: `NODE_${projectId}`,
      repoOwner: 'octo',
      repoName: 'alpha',
      repoUrl: 'https://github.com/octo/alpha',
      defaultBranch: 'main',
      status: 'active',
    })

    expect(markPrompted(ctx.db, candidate.id)).toBe(true)
    expect(beginRegistration(ctx.db, candidate.id, new Date('2026-09-02T03:00:00.000Z'))).toBe(true)
    expect(getCandidate(ctx.db, candidate.id)).toMatchObject({
      status: 'registering',
      attemptCount: 1,
      decisionAt: '2026-09-02T03:00:00.000Z',
    })
    expect(markRegistered(ctx.db, candidate.id, projectId)).toBe(true)
    expect(getCandidate(ctx.db, candidate.id)).toMatchObject({
      status: 'registered',
      projectId,
    })
  })

  it('allows exactly two registration attempts and then fails the candidate', () => {
    const candidate = detect(ctx)
    expect(beginRegistration(ctx.db, candidate.id)).toBe(true)
    expect(recordFailure(ctx.db, candidate.id, 'REMOTE_SETUP_FAILED', 'attempt 1 failed')).toBe(
      true,
    )
    expect(getCandidate(ctx.db, candidate.id)).toMatchObject({
      status: 'registering',
      attemptCount: 1,
      lastErrorCode: 'REMOTE_SETUP_FAILED',
    })

    expect(beginRegistration(ctx.db, candidate.id)).toBe(true)
    expect(recordFailure(ctx.db, candidate.id, 'INITIAL_PUSH_FAILED', 'attempt 2 failed')).toBe(
      true,
    )
    expect(getCandidate(ctx.db, candidate.id)).toMatchObject({
      status: 'failed',
      attemptCount: 2,
      lastErrorCode: 'INITIAL_PUSH_FAILED',
    })

    // 3 回目の attempt は state 側で拒否され attempt_count も動かない
    expect(beginRegistration(ctx.db, candidate.id)).toBe(false)
    expect(getCandidate(ctx.db, candidate.id)?.attemptCount).toBe(2)
  })

  it('truncates a long error message and code to the column limits', () => {
    const candidate = detect(ctx)
    beginRegistration(ctx.db, candidate.id)
    expect(recordFailure(ctx.db, candidate.id, 'X'.repeat(100), 'y'.repeat(900))).toBe(true)
    const stored = getCandidate(ctx.db, candidate.id)
    expect(stored?.lastErrorCode).toHaveLength(64)
    expect(stored?.lastErrorMessage).toHaveLength(500)
  })

  it('declines without registering and reopens into a fresh attempt cycle', () => {
    const candidate = detect(ctx)
    expect(declineCandidate(ctx.db, candidate.id, new Date('2026-09-02T04:00:00.000Z'))).toBe(true)
    expect(getCandidate(ctx.db, candidate.id)).toMatchObject({
      status: 'declined',
      decisionAt: '2026-09-02T04:00:00.000Z',
    })
    expect(declineCandidate(ctx.db, candidate.id)).toBe(false)
    expect(beginRegistration(ctx.db, candidate.id)).toBe(false)

    expect(reopenCandidate(ctx.db, candidate.id)).toBe(true)
    expect(getCandidate(ctx.db, candidate.id)).toMatchObject({
      status: 'detected',
      attemptCount: 0,
      decisionAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    })
    expect(beginRegistration(ctx.db, candidate.id)).toBe(true)
  })

  it('rejects transitions that do not start from the expected state', () => {
    const candidate = detect(ctx)
    expect(markRegistered(ctx.db, candidate.id, randomUUID())).toBe(false)
    expect(recordFailure(ctx.db, candidate.id, 'X', 'y')).toBe(false)
    expect(reopenCandidate(ctx.db, candidate.id)).toBe(false)

    beginRegistration(ctx.db, candidate.id)
    expect(markPrompted(ctx.db, candidate.id)).toBe(false)
    expect(declineCandidate(ctx.db, candidate.id)).toBe(false)
    expect(getCandidate(ctx.db, randomUUID())).toBeNull()
  })

  it('lists newest seen first and filters by status', () => {
    const a = detect(ctx, PATH_A)
    const b = upsertDetected(
      ctx.db,
      { localPath: PATH_B, agent: 'claude', suggestedName: 'beta' },
      new Date('2026-09-02T05:00:00.000Z'),
    )
    declineCandidate(ctx.db, a.id)

    expect(listCandidates(ctx.db).map((c) => c.id)).toEqual([b.id, a.id])
    expect(listCandidates(ctx.db, 'declined').map((c) => c.id)).toEqual([a.id])
    expect(listCandidates(ctx.db, 'detected').map((c) => c.id)).toEqual([b.id])
  })
})
