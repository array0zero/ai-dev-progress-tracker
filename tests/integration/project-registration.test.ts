import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProjectById, listProjects } from '../../src/server/db/project-repository.js'
import { getLatestCommit } from '../../src/server/db/run-repository.js'
import { beginMarker } from '../../src/server/services/hook-service.js'
import { registerProject } from '../../src/server/services/project-service.js'
import { createFakeGh, type FakeGh } from '../helpers/fake-gh.js'
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

function repoView(id: string, slug: string): Record<string, unknown> {
  return {
    id,
    nameWithOwner: slug,
    url: `https://github.com/${slug}`,
    visibility: 'PRIVATE',
    defaultBranchRef: { name: 'main' },
  }
}

describe('project registration', () => {
  let ctx: TestDb
  let repo: TempRepo
  let fake: FakeGh

  beforeEach(() => {
    ctx = createTestDb()
    repo = createTempRepo({ origin: 'https://github.com/acme/widget.git' })
    fake = createFakeGh({
      authStatusExitCode: 0,
      repos: {
        'acme/widget': { repoView: repoView('REPO_NODE_ACME_WIDGET', 'acme/widget') },
        'evil/other': { repoView: repoView('REPO_NODE_EVIL', 'evil/other') },
      },
    })
    for (const [key, value] of Object.entries(fake.env)) {
      vi.stubEnv(key, value)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fake.cleanup()
    repo.cleanup()
    ctx.cleanup()
  })

  it('registers a matching local repo and GitHub repo (steps 1-14)', async () => {
    const result = await registerProject(
      { name: 'Widget', localPath: repo.root, repository: 'acme/widget' },
      ctx.db,
      { autoRecover: false, autoBackup: false },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    const stored = getProjectById(ctx.db, result.project.id)
    expect(stored?.repoNodeId).toBe('REPO_NODE_ACME_WIDGET')
    expect(stored?.localPath).toBe(realpathSync(repo.root))
    expect(stored?.repoUrl).toBe('https://github.com/acme/widget')

    const commit = getLatestCommit(ctx.db, result.project.id)
    expect(commit?.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.project.lastCommitSha).toBe(commit?.sha)

    const gitHooks = join(realpathSync(repo.root), '.git', 'hooks')
    expect(readFileSync(join(gitHooks, 'post-commit'), 'utf8')).toContain(
      beginMarker(result.project.id),
    )
    expect(readFileSync(join(gitHooks, 'pre-push'), 'utf8')).toContain(
      beginMarker(result.project.id),
    )
  })

  it('redacts a secret in the HEAD commit message at registration', async () => {
    const token = 'ghp_0123456789abcdefghijABCDEFGHIJKL'
    repo.git('commit', '--allow-empty', '-m', `add deploy notes ${token}`)

    const result = await registerProject(
      { name: 'Widget', localPath: repo.root, repository: 'acme/widget' },
      ctx.db,
      { autoRecover: false, autoBackup: false },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    const commit = getLatestCommit(ctx.db, result.project.id)
    expect(commit?.message).not.toContain(token)
    expect(commit?.message).toContain('[REDACTED]')
  })

  it('rejects when origin does not match the requested repository and stores nothing', async () => {
    const result = await registerProject(
      { name: 'X', localPath: repo.root, repository: 'evil/other' },
      ctx.db,
      { autoRecover: false, autoBackup: false },
    )
    expect(result).toMatchObject({ ok: false, status: 422, code: 'REPOSITORY_MISMATCH' })
    expect(listProjects(ctx.db)).toHaveLength(0)
  })

  it('rejects a duplicate registration with 409 and keeps a single row', async () => {
    await registerProject(
      { name: 'Widget', localPath: repo.root, repository: 'acme/widget' },
      ctx.db,
      { autoRecover: false, autoBackup: false },
    )
    const again = await registerProject(
      { name: 'Widget again', localPath: repo.root, repository: 'acme/widget' },
      ctx.db,
      { autoRecover: false, autoBackup: false },
    )
    expect(again).toMatchObject({ ok: false, status: 409, code: 'PROJECT_ALREADY_REGISTERED' })
    expect(listProjects(ctx.db)).toHaveLength(1)
  })

  it('does not leak another repository into the registered project', async () => {
    const result = await registerProject(
      { name: 'Widget', localPath: repo.root, repository: 'acme/widget' },
      ctx.db,
      { autoRecover: false, autoBackup: false },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const stored = getProjectById(ctx.db, result.project.id)
    expect(stored?.repoName).toBe('widget')
    expect(JSON.stringify(stored)).not.toContain('evil')
    for (const call of fake.calls()) {
      expect(call.join(' ')).not.toContain('evil/other')
    }
  })
})
