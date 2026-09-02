import { describe, expect, it } from 'vitest'
import type { SnapshotView } from '../../src/server/db/progress-repository.js'
import {
  fallbackCurrentPosition,
  hasNextAction,
  isUnreflected,
  readHeads,
  WAITING_FOR_FIRST_COMMIT,
  WAITING_FOR_GENERATION,
} from '../../src/server/services/freshness-service.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function view(overrides: Partial<SnapshotView> = {}): SnapshotView {
  return {
    recoveryStatus: 'complete',
    currentPosition: { status: 'confirmed', text: 'x', evidenceIds: [] },
    completedItems: { status: 'confirmed', items: [], evidenceIds: [] },
    nextActions: {
      status: 'confirmed',
      items: [{ text: 'next', evidenceIds: [] }],
      evidenceIds: [],
    },
    importantDecisions: { status: 'confirmed', items: [], evidenceIds: [] },
    evidenceIds: [],
    ...overrides,
  } as SnapshotView
}

describe('isUnreflected', () => {
  it('is false without a local HEAD', () => {
    expect(isUnreflected(null, null)).toBe(false)
    expect(isUnreflected(null, SHA_A)).toBe(false)
  })

  it('is true when there is a HEAD but no snapshot', () => {
    expect(isUnreflected(SHA_A, null)).toBe(true)
  })

  it('is true when the snapshot is for a different commit', () => {
    expect(isUnreflected(SHA_A, SHA_B)).toBe(true)
  })

  it('is false when the snapshot matches the HEAD', () => {
    expect(isUnreflected(SHA_A, SHA_A)).toBe(false)
  })
})

describe('hasNextAction', () => {
  it('is true only for a confirmed field with items', () => {
    expect(hasNextAction(view())).toBe(true)
    expect(
      hasNextAction(view({ nextActions: { status: 'confirmed', items: [], evidenceIds: [] } })),
    ).toBe(false)
    expect(
      hasNextAction(
        view({
          nextActions: { status: 'needs_input', items: [], evidenceIds: [] },
        }),
      ),
    ).toBe(false)
    expect(hasNextAction(null)).toBe(false)
  })
})

describe('fallbackCurrentPosition', () => {
  it('waits for the first commit without a HEAD and for generation with one', () => {
    expect(fallbackCurrentPosition(null)).toBe(WAITING_FOR_FIRST_COMMIT)
    expect(fallbackCurrentPosition(SHA_A)).toBe(WAITING_FOR_GENERATION)
  })
})

describe('readHeads', () => {
  it('returns an empty map for zero projects', async () => {
    expect(await readHeads([])).toEqual(new Map())
  })

  it('never runs more than the configured number of lookups at once', async () => {
    const projects = Array.from({ length: 9 }, (_, index) => ({
      id: `p${index}`,
      localPath: `/missing/${index}`,
    }))

    const heads = await readHeads(projects, 4)
    expect(heads.size).toBe(9)
    // 存在しない path は HEAD なし
    expect([...heads.values()].every((head) => head === null)).toBe(true)
  })
})
