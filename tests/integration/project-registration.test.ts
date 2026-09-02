import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginRegistration,
  getCandidate,
  upsertDetected,
} from '../../src/server/db/candidate-repository.js'
import { getProjectById, listProjects } from '../../src/server/db/project-repository.js'
import { getLatestCommit } from '../../src/server/db/run-repository.js'
import { beginMarker } from '../../src/server/services/hook-service.js'
import { registerProject } from '../../src/server/services/project-service.js'
import { runRegistration } from '../../src/server/services/registration-service.js'
import { createFakeGh, type FakeGh } from '../helpers/fake-gh.js'
import { createTempDir, createTempRepo, type TempRepo } from '../helpers/temp-repo.js'
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

describe('automatic registration state machine', () => {
  let ctx: TestDb
  let fake: FakeGh
  let remoteDir: string

  function stubGh(fixtures: Parameters<typeof createFakeGh>[0]): void {
    fake?.cleanup()
    fake = createFakeGh({ authStatusExitCode: 0, createRemoteDir: remoteDir, ...fixtures })
    for (const [key, value] of Object.entries(fake.env)) {
      vi.stubEnv(key, value)
    }
  }

  function approve(localPath: string, name: string): string {
    const candidate = upsertDetected(ctx.db, { localPath, agent: 'codex', suggestedName: name })
    beginRegistration(ctx.db, candidate.id)
    return candidate.id
  }

  beforeEach(() => {
    ctx = createTestDb()
    remoteDir = mkdtempSync(join(tmpdir(), 'adpt-remotes-'))
    stubGh({ login: 'octocat' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fake.cleanup()
    rmSync(remoteDir, { recursive: true, force: true })
    ctx.cleanup()
  })

  it('initializes Git, creates a private repo and registers a folder with no commits', async () => {
    const folder = createTempDir('adpt-reg-')
    try {
      const candidateId = approve(folder.root, 'Fresh Project')
      const result = await runRegistration(ctx.db, candidateId, {
        autoRecover: false,
        autoBackup: false,
      })
      expect(result).toMatchObject({ ok: true })
      if (!result.ok) {
        return
      }

      const project = getProjectById(ctx.db, result.projectId)
      expect(project).toMatchObject({
        name: 'Fresh Project',
        repoOwner: 'octocat',
        repoName: 'fresh-project',
        registrationSource: 'codex',
        summary: 'Fresh Project',
      })
      expect(getLatestCommit(ctx.db, result.projectId)).toBeNull()
      expect(getCandidate(ctx.db, candidateId)).toMatchObject({
        status: 'registered',
        projectId: result.projectId,
      })

      const root = realpathSync.native(folder.root)
      expect(
        execFileSync('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('main')
      const origin = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
      }).trim()
      expect(execFileSync('git', ['ls-remote', origin], { encoding: 'utf8' }).trim()).toBe('')
      expect(fake.calls().some((call) => call[0] === 'repo' && call[1] === 'create')).toBe(true)
    } finally {
      folder.cleanup()
    }
  })

  it('pushes the initial commit and verifies the remote SHA before registering', async () => {
    const folder = createTempDir('adpt-reg-')
    try {
      const root = folder.root
      execFileSync('git', ['-C', root, 'init', '-b', 'main'])
      execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User'])
      execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false'])
      writeFileSync(join(root, 'README.md'), '# Heading\n\nThis project tracks progress.\n')
      execFileSync('git', ['-C', root, 'add', '.'])
      execFileSync('git', ['-C', root, 'commit', '-m', 'initial'])
      const localHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()

      const candidateId = approve(root, 'Pushed Project')
      const result = await runRegistration(ctx.db, candidateId, {
        autoRecover: false,
        autoBackup: false,
      })
      expect(result).toMatchObject({ ok: true })
      if (!result.ok) {
        return
      }

      const remoteSha = execFileSync(
        'git',
        ['-C', realpathSync.native(root), 'ls-remote', 'origin', 'refs/heads/main'],
        { encoding: 'utf8' },
      )
        .trim()
        .split(/\s+/)[0]
      expect(remoteSha).toBe(localHead)
      expect(getLatestCommit(ctx.db, result.projectId)?.sha).toBe(localHead)
      expect(getProjectById(ctx.db, result.projectId)?.summary).toBe(
        'This project tracks progress.',
      )
    } finally {
      folder.cleanup()
    }
  })

  it('reuses an existing GitHub origin without creating a repository', async () => {
    const existing = createTempRepo({ origin: 'https://github.com/acme/existing.git' })
    try {
      stubGh({
        login: 'octocat',
        repos: {
          'acme/existing': {
            repoView: {
              id: 'NODE_EXISTING',
              nameWithOwner: 'acme/existing',
              url: 'https://github.com/acme/existing',
              visibility: 'PRIVATE',
              defaultBranchRef: { name: 'main' },
              description: 'Existing repository description',
            },
          },
        },
      })

      const candidateId = approve(existing.root, 'Existing Project')
      const result = await runRegistration(ctx.db, candidateId, {
        autoRecover: false,
        autoBackup: false,
      })
      expect(result).toMatchObject({ ok: true })
      if (!result.ok) {
        return
      }
      expect(getProjectById(ctx.db, result.projectId)).toMatchObject({
        repoOwner: 'acme',
        repoName: 'existing',
        summary: 'Existing repository description',
      })
      expect(fake.calls().some((call) => call[0] === 'repo' && call[1] === 'create')).toBe(false)
    } finally {
      existing.cleanup()
    }
  })

  it('stops with REPOSITORY_NAME_CONFLICT instead of inventing a suffix', async () => {
    const folder = createTempDir('adpt-reg-')
    try {
      stubGh({
        login: 'octocat',
        repos: {
          'octocat/taken-name': {
            repoView: {
              id: 'NODE_TAKEN',
              nameWithOwner: 'octocat/taken-name',
              url: 'https://github.com/octocat/taken-name',
              visibility: 'PRIVATE',
              defaultBranchRef: { name: 'main' },
            },
          },
        },
      })

      const candidateId = approve(folder.root, 'Taken Name')
      const result = await runRegistration(ctx.db, candidateId, {
        autoRecover: false,
        autoBackup: false,
      })
      expect(result).toEqual({
        ok: false,
        code: 'REPOSITORY_NAME_CONFLICT',
        message: expect.any(String),
      })
      expect(listProjects(ctx.db)).toEqual([])
      expect(fake.calls().some((call) => call[0] === 'repo' && call[1] === 'create')).toBe(false)
    } finally {
      folder.cleanup()
    }
  })

  it('does not register when the initial push cannot be verified', async () => {
    const repo = createTempRepo()
    try {
      stubGh({ login: 'octocat', createRemoteDir: undefined })
      const candidateId = approve(repo.root, 'No Remote')
      const result = await runRegistration(ctx.db, candidateId, {
        autoRecover: false,
        autoBackup: false,
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(['REMOTE_SETUP_FAILED', 'INITIAL_PUSH_FAILED']).toContain(result.code)
      expect(listProjects(ctx.db)).toEqual([])
      expect(getCandidate(ctx.db, candidateId)?.status).toBe('registering')
    } finally {
      repo.cleanup()
    }
  })
})
