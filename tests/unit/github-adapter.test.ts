import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkAuth,
  listIssues,
  listPullRequests,
  viewRepo,
} from '../../src/server/adapters/github.js'
import { createFakeGh, type FakeGh } from '../helpers/fake-gh.js'

function applyFakeGhEnv(fake: FakeGh): void {
  for (const [key, value] of Object.entries(fake.env)) {
    vi.stubEnv(key, value)
  }
}

describe('github adapter', () => {
  const fakes: FakeGh[] = []

  function fakeGh(fixtures: Parameters<typeof createFakeGh>[0]): FakeGh {
    const fake = createFakeGh(fixtures)
    fakes.push(fake)
    applyFakeGhEnv(fake)
    return fake
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    while (fakes.length > 0) {
      fakes.pop()?.cleanup()
    }
  })

  it('reports authenticated only when gh auth status exits 0', async () => {
    fakeGh({ authStatusExitCode: 0 })
    expect(await checkAuth()).toBe(true)
  })

  it('reports not authenticated when gh auth status exits non-zero', async () => {
    fakeGh({ authStatusExitCode: 1 })
    expect(await checkAuth()).toBe(false)
  })

  it('normalizes repo view output', async () => {
    fakeGh({
      repos: {
        'octo/demo': {
          repoView: {
            id: 'R_123',
            nameWithOwner: 'octo/demo',
            url: 'https://github.com/octo/demo',
            visibility: 'PRIVATE',
            defaultBranchRef: { name: 'main' },
          },
        },
      },
    })
    const result = await viewRepo('octo/demo')
    expect(result).toEqual({
      ok: true,
      repo: {
        id: 'R_123',
        nameWithOwner: 'octo/demo',
        url: 'https://github.com/octo/demo',
        visibility: 'PRIVATE',
        defaultBranch: 'main',
      },
    })
  })

  it('maps a null defaultBranchRef to null', async () => {
    fakeGh({
      repoView: {
        id: 'R_9',
        nameWithOwner: 'octo/empty',
        url: 'https://github.com/octo/empty',
        visibility: 'PRIVATE',
        defaultBranchRef: null,
      },
    })
    const result = await viewRepo('octo/empty')
    expect(result.ok && result.repo.defaultBranch).toBeNull()
  })

  it('caps issue bodies at 8000 chars, sorts by updatedAt desc, and always passes -R', async () => {
    const fake = fakeGh({
      repos: {
        'octo/demo': {
          issues: [
            {
              number: 1,
              title: 'old',
              state: 'CLOSED',
              body: 'a'.repeat(10_000),
              updatedAt: '2026-01-01T00:00:00Z',
              url: 'https://github.com/octo/demo/issues/1',
              labels: [{ name: 'bug' }, { name: 'p1' }],
            },
            {
              number: 2,
              title: 'new',
              state: 'OPEN',
              body: 'short',
              updatedAt: '2026-03-01T00:00:00Z',
              url: 'https://github.com/octo/demo/issues/2',
              labels: [],
            },
          ],
        },
        'evil/other': {
          issues: [
            {
              number: 99,
              title: 'leak',
              state: 'OPEN',
              body: 'SHOULD_NOT_APPEAR',
              updatedAt: '2026-09-01T00:00:00Z',
              url: 'https://github.com/evil/other/issues/99',
              labels: [],
            },
          ],
        },
      },
    })

    const issues = await listIssues('octo/demo')
    expect(issues.map((issue) => issue.number)).toEqual([2, 1])
    expect(issues[1]?.body.length).toBe(8_000)
    expect(issues[0]?.labels).toEqual([])
    expect(issues[1]?.labels).toEqual(['bug', 'p1'])
    expect(JSON.stringify(issues)).not.toContain('SHOULD_NOT_APPEAR')

    for (const call of fake.calls()) {
      if (call[0] === 'issue' && call[1] === 'list') {
        const dashR = call.indexOf('-R')
        expect(dashR).toBeGreaterThan(-1)
        expect(call[dashR + 1]).toBe('octo/demo')
      }
    }
  })

  it('passes -R and normalizes pull requests', async () => {
    const fake = fakeGh({
      repos: {
        'octo/demo': {
          pulls: [
            {
              number: 7,
              title: 'feature',
              state: 'MERGED',
              body: 'b'.repeat(9_000),
              updatedAt: '2026-05-01T00:00:00Z',
              mergedAt: '2026-05-02T00:00:00Z',
              url: 'https://github.com/octo/demo/pull/7',
              headRefName: 'feat',
              baseRefName: 'main',
            },
          ],
        },
      },
    })
    const pulls = await listPullRequests('octo/demo')
    expect(pulls[0]?.body.length).toBe(8_000)
    expect(pulls[0]?.mergedAt).toBe('2026-05-02T00:00:00Z')

    const prCall = fake.calls().find((call) => call[0] === 'pr' && call[1] === 'list')
    expect(prCall).toBeDefined()
    expect(prCall?.includes('-R')).toBe(true)
    expect(prCall?.[prCall.indexOf('-R') + 1]).toBe('octo/demo')
  })
})
