import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getHeadCommit,
  inspectRepository,
  normalizeGitHubOrigin,
} from '../../src/server/adapters/git.js'
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js'

describe('normalizeGitHubOrigin', () => {
  it('normalizes HTTPS and SSH origins to the same owner/repo', () => {
    const expected = { owner: 'octocat', repo: 'Hello-World' }
    expect(normalizeGitHubOrigin('https://github.com/octocat/Hello-World.git')).toEqual(expected)
    expect(normalizeGitHubOrigin('https://github.com/octocat/Hello-World')).toEqual(expected)
    expect(normalizeGitHubOrigin('git@github.com:octocat/Hello-World.git')).toEqual(expected)
    expect(normalizeGitHubOrigin('ssh://git@github.com/octocat/Hello-World.git')).toEqual(expected)
    expect(normalizeGitHubOrigin('https://github.com/octocat/Hello-World/')).toEqual(expected)
  })

  it('returns null for non-GitHub origins', () => {
    expect(normalizeGitHubOrigin('https://gitlab.com/octocat/Hello-World.git')).toBeNull()
    expect(normalizeGitHubOrigin('/local/path/repo.git')).toBeNull()
  })
})

describe('inspectRepository', () => {
  const repos: TempRepo[] = []

  function makeRepo(options: Parameters<typeof createTempRepo>[0] = {}): TempRepo {
    const repo = createTempRepo(options)
    repos.push(repo)
    return repo
  }

  afterEach(() => {
    while (repos.length > 0) {
      repos.pop()?.cleanup()
    }
  })

  it('accepts a standard repo whose origin matches the requested repo (HTTPS)', async () => {
    const repo = makeRepo({ origin: 'https://github.com/acme/widget.git' })
    const result = await inspectRepository(repo.root, 'acme/widget')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.layout.origin).toEqual({ owner: 'acme', repo: 'widget' })
      expect(result.layout.headSha).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it('accepts an SSH origin', async () => {
    const repo = makeRepo({ origin: 'git@github.com:acme/widget.git' })
    const result = await inspectRepository(repo.root, 'acme/widget')
    expect(result.ok).toBe(true)
  })

  it('rejects a subdirectory of the git root with NOT_GIT_ROOT', async () => {
    const repo = makeRepo({ origin: 'https://github.com/acme/widget.git' })
    const sub = join(repo.root, 'packages', 'inner')
    mkdirSync(sub, { recursive: true })
    const result = await inspectRepository(sub, 'acme/widget')
    expect(result).toEqual({ ok: false, code: 'NOT_GIT_ROOT' })
  })

  it('rejects a non-existent path with NOT_GIT_ROOT', async () => {
    const result = await inspectRepository(join(tmpNonExistent(), 'nope'), 'acme/widget')
    expect(result).toEqual({ ok: false, code: 'NOT_GIT_ROOT' })
  })

  it('rejects a linked worktree with GIT_LAYOUT_UNSUPPORTED', async () => {
    const repo = makeRepo({ origin: 'https://github.com/acme/widget.git' })
    const worktree = join(repo.parent, 'wt')
    repo.git('worktree', 'add', worktree)
    const result = await inspectRepository(worktree, 'acme/widget')
    expect(result).toEqual({ ok: false, code: 'GIT_LAYOUT_UNSUPPORTED' })
  })

  it('rejects a repo with core.hooksPath set with CUSTOM_HOOKS_PATH_UNSUPPORTED', async () => {
    const repo = makeRepo({ origin: 'https://github.com/acme/widget.git', hooksPath: '.husky' })
    const result = await inspectRepository(repo.root, 'acme/widget')
    expect(result).toEqual({ ok: false, code: 'CUSTOM_HOOKS_PATH_UNSUPPORTED' })
  })

  it('rejects when the origin does not match the requested repo with REPOSITORY_MISMATCH', async () => {
    const repo = makeRepo({ origin: 'https://github.com/acme/widget.git' })
    const result = await inspectRepository(repo.root, 'someone-else/other')
    expect(result).toEqual({ ok: false, code: 'REPOSITORY_MISMATCH' })
  })

  it('rejects when there is no origin with REPOSITORY_MISMATCH', async () => {
    const repo = makeRepo()
    const result = await inspectRepository(repo.root, 'acme/widget')
    expect(result).toEqual({ ok: false, code: 'REPOSITORY_MISMATCH' })
  })

  it('reads HEAD commit metadata', async () => {
    const repo = makeRepo({ origin: 'https://github.com/acme/widget.git' })
    const commit = await getHeadCommit(repo.root)
    expect(commit?.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(commit?.message).toContain('initial commit')
    expect(commit?.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(commit?.parentSha).toBeNull()
  })
})

function tmpNonExistent(): string {
  return join(process.cwd(), 'this-path', `does-not-exist-${Date.now()}`)
}
