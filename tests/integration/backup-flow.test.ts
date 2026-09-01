import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runHookBackup } from '../../src/cli/commands/hook-backup.js'
import { getBackupRunById, getLatestBackupRun } from '../../src/server/db/backup-repository.js'
import type { Db } from '../../src/server/db/connection.js'
import { getLease } from '../../src/server/db/lease-repository.js'
import { insertRun, listRunsByProject } from '../../src/server/db/run-repository.js'
import {
  BACKUP_GITATTRIBUTES,
  BACKUP_SCOPE,
  type BackupGitDeps,
  enqueueBackup,
  exportBackupData,
  runBackup,
} from '../../src/server/services/backup-service.js'
import { registerProject } from '../../src/server/services/project-service.js'
import { createFakeGh, type FakeGh } from '../helpers/fake-gh.js'
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

function repoView(slug: string): Record<string, unknown> {
  return {
    id: `NODE_${slug.replace('/', '_')}`,
    nameWithOwner: slug,
    url: `https://github.com/${slug}`,
    visibility: 'PRIVATE',
    defaultBranchRef: { name: 'main' },
  }
}

const OK_ENSURE = async () => ({
  ok: true as const,
  slug: 'fake-user/ai-dev-progress-tracker-backup',
  created: false,
})

function fakeGitDeps(): { deps: BackupGitDeps; calls: string[] } {
  const calls: string[] = []
  const deps: BackupGitDeps = {
    clone: async (_url, dest) => {
      calls.push('clone')
      mkdirSync(join(dest, '.git'), { recursive: true })
      return true
    },
    pullFfOnly: async () => {
      calls.push('pull')
      return true
    },
    head: async () => 'HEAD_SHA_AAAA',
    commitPush: async () => {
      calls.push('commitPush')
      return { ok: true, sha: 'NEW_SHA_BBBB' }
    },
  }
  return { deps, calls }
}

describe('backup flow', () => {
  let ctx: TestDb
  let repo: TempRepo
  let fake: FakeGh
  let cloneDir: string

  async function register(db: Db, options: Record<string, unknown> = {}): Promise<string> {
    const result = await registerProject(
      { name: 'acme/widget', localPath: repo.root, repository: 'acme/widget' },
      db,
      { autoRecover: false, spawnWorker: () => undefined, ...options },
    )
    if (!result.ok) {
      throw new Error(`registration failed: ${result.code}`)
    }
    return result.project.id
  }

  beforeEach(() => {
    ctx = createTestDb()
    repo = createTempRepo({ origin: 'https://github.com/acme/widget.git' })
    fake = createFakeGh({
      authStatusExitCode: 0,
      login: 'fake-user',
      repos: { 'acme/widget': { repoView: repoView('acme/widget') } },
    })
    for (const [key, value] of Object.entries(fake.env)) {
      vi.stubEnv(key, value)
    }
    cloneDir = join(mkdtempSync(join(tmpdir(), 'adpt-backup-')), 'backup-repo')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fake.cleanup()
    repo.cleanup()
    ctx.cleanup()
    rmSync(cloneDir, { recursive: true, force: true })
  })

  it('queues one registration backup run and does not spawn (test seam)', async () => {
    const projectId = await register(ctx.db)
    const backup = getLatestBackupRun(ctx.db)
    expect(backup?.trigger).toBe('registration')
    expect(backup?.status).toBe('queued')
    expect(backup?.projectId).toBe(projectId)
  })

  it('pre-push hook queues a backup run without adding a generation run', async () => {
    const projectId = await register(ctx.db, { autoBackup: false })
    const generationsBefore = listRunsByProject(ctx.db, projectId).length

    const headSha = repo.git('rev-parse', 'HEAD')
    const code = await runHookBackup(
      { projectId, repo: repo.root, sha: headSha },
      { db: ctx.db, spawnWorker: () => undefined },
    )
    expect(code).toBe(0)

    const backup = getLatestBackupRun(ctx.db)
    expect(backup?.trigger).toBe('pre_push')
    expect(backup?.status).toBe('queued')
    expect(listRunsByProject(ctx.db, projectId).length).toBe(generationsBefore)
  })

  it('holds a single backup lease for two concurrent enqueues', async () => {
    const first = enqueueBackup(ctx.db, {
      trigger: 'manual',
      projectId: null,
      sourceCommitSha: null,
      backupRepo: 'x/y',
    })
    const second = enqueueBackup(ctx.db, {
      trigger: 'manual',
      projectId: null,
      sourceCommitSha: null,
      backupRepo: 'x/y',
    })
    expect(first.shouldSpawn).toBe(true)
    expect(second.shouldSpawn).toBe(false)
    expect(getLease(ctx.db, BACKUP_SCOPE)?.ownerToken).toBe(first.ownerToken)
  })

  it('records the backup commit SHA on a successful run', async () => {
    const projectId = await register(ctx.db, { autoBackup: false })
    const headSha = repo.git('rev-parse', 'HEAD')
    const enq = enqueueBackup(ctx.db, {
      trigger: 'pre_push',
      projectId,
      sourceCommitSha: headSha,
      backupRepo: 'fake-user/ai-dev-progress-tracker-backup',
    })
    const run = getBackupRunById(ctx.db, enq.runId)
    if (run === null) {
      throw new Error('run missing')
    }
    const { deps, calls } = fakeGitDeps()

    await runBackup(ctx.db, run, {
      cloneDir,
      settleTimeoutMs: 500,
      settlePollMs: 20,
      ensureRepo: OK_ENSURE,
      git: deps,
    })

    const done = getBackupRunById(ctx.db, run.id)
    expect(done?.status).toBe('succeeded')
    expect(done?.backupCommitSha).toBe('NEW_SHA_BBBB')
    expect(calls).toContain('clone')
    expect(calls).toContain('commitPush')
  })

  it('performs the first backup against an empty backup repo without pulling', async () => {
    const projectId = await register(ctx.db, { autoBackup: false })
    const headSha = repo.git('rev-parse', 'HEAD')
    const enq = enqueueBackup(ctx.db, {
      trigger: 'pre_push',
      projectId,
      sourceCommitSha: headSha,
      backupRepo: 'fake-user/ai-dev-progress-tracker-backup',
    })
    const run = getBackupRunById(ctx.db, enq.runId)
    if (run === null) {
      throw new Error('run missing')
    }

    // 空の backup repo を clone 済み: `.git` はあるが commit は無い (unborn HEAD)。
    mkdirSync(join(cloneDir, '.git'), { recursive: true })
    const calls: string[] = []
    const deps: BackupGitDeps = {
      clone: async () => {
        calls.push('clone')
        return true
      },
      pullFfOnly: async () => {
        calls.push('pull')
        return false // 空 repo からの pull は参照が無く失敗する
      },
      head: async () => null, // commit が無い
      commitPush: async () => {
        calls.push('commitPush')
        return { ok: true, sha: 'FIRST_BACKUP_SHA' }
      },
    }

    await runBackup(ctx.db, run, {
      cloneDir,
      settleTimeoutMs: 300,
      settlePollMs: 20,
      ensureRepo: OK_ENSURE,
      git: deps,
    })

    const done = getBackupRunById(ctx.db, run.id)
    expect(done?.status).toBe('succeeded')
    expect(done?.backupCommitSha).toBe('FIRST_BACKUP_SHA')
    expect(calls).not.toContain('pull') // unborn HEAD では pull しない
    expect(calls).toContain('commitPush')
  })

  it('fails with BACKUP_PULL_FAILED when a non-empty clone cannot fast-forward', async () => {
    const projectId = await register(ctx.db, { autoBackup: false })
    const enq = enqueueBackup(ctx.db, {
      trigger: 'pre_push',
      projectId,
      sourceCommitSha: repo.git('rev-parse', 'HEAD'),
      backupRepo: 'fake-user/ai-dev-progress-tracker-backup',
    })
    const run = getBackupRunById(ctx.db, enq.runId)
    if (run === null) {
      throw new Error('run missing')
    }

    mkdirSync(join(cloneDir, '.git'), { recursive: true })
    const deps: BackupGitDeps = {
      clone: async () => true,
      pullFfOnly: async () => false,
      head: async () => 'EXISTING_SHA', // commit がある clone
      commitPush: async () => ({ ok: true, sha: 'X' }),
    }

    await runBackup(ctx.db, run, {
      cloneDir,
      settleTimeoutMs: 300,
      settlePollMs: 20,
      ensureRepo: OK_ENSURE,
      git: deps,
    })

    const done = getBackupRunById(ctx.db, run.id)
    expect(done?.status).toBe('failed')
    expect(done?.errorCode).toBe('BACKUP_PULL_FAILED')
  })

  it('fails the run when the backup repo cannot be ensured', async () => {
    const projectId = await register(ctx.db, { autoBackup: false })
    const enq = enqueueBackup(ctx.db, {
      trigger: 'pre_push',
      projectId,
      sourceCommitSha: repo.git('rev-parse', 'HEAD'),
      backupRepo: 'x/y',
    })
    const run = getBackupRunById(ctx.db, enq.runId)
    if (run === null) {
      throw new Error('run missing')
    }

    await runBackup(ctx.db, run, {
      cloneDir,
      settleTimeoutMs: 300,
      settlePollMs: 20,
      ensureRepo: async () => ({ ok: false as const, code: 'BACKUP_REPO_NOT_PRIVATE' }),
      git: fakeGitDeps().deps,
    })

    const done = getBackupRunById(ctx.db, run.id)
    expect(done?.status).toBe('failed')
    expect(done?.errorCode).toBe('BACKUP_REPO_NOT_PRIVATE')
  })

  it('waits for the source-commit generation to settle and times out with GENERATION_NOT_SETTLED', async () => {
    const projectId = await register(ctx.db, { autoBackup: false })
    const headSha = repo.git('rev-parse', 'HEAD')
    // 対象 commit の generation run を running のまま置く
    insertRun(ctx.db, {
      id: 'gen-running',
      dedupeKey: `generation:${projectId}:${headSha}`,
      projectId,
      commitSha: headSha,
      mode: 'generation',
      trigger: 'post_commit',
      detectedAt: '2026-09-01T00:00:00.000Z',
    })
    ctx.db.prepare("UPDATE generation_runs SET status = 'running' WHERE id = 'gen-running'").run()

    const enq = enqueueBackup(ctx.db, {
      trigger: 'pre_push',
      projectId,
      sourceCommitSha: headSha,
      backupRepo: 'x/y',
    })
    const run = getBackupRunById(ctx.db, enq.runId)
    if (run === null) {
      throw new Error('run missing')
    }
    const { deps, calls } = fakeGitDeps()

    await runBackup(ctx.db, run, {
      cloneDir,
      settleTimeoutMs: 150,
      settlePollMs: 20,
      ensureRepo: OK_ENSURE,
      git: deps,
    })

    const done = getBackupRunById(ctx.db, run.id)
    expect(done?.status).toBe('failed')
    expect(done?.errorCode).toBe('GENERATION_NOT_SETTLED')
    expect(calls).toEqual([]) // export/clone/push は行わない
  })

  it('does not create a new backup commit when the export is byte-identical', async () => {
    const projectId = await register(ctx.db, { autoBackup: false })
    const headSha = repo.git('rev-parse', 'HEAD')

    // clone を「既にある」状態にし、前回 export と同一の data・`.gitattributes` を置く
    mkdirSync(join(cloneDir, '.git'), { recursive: true })
    mkdirSync(join(cloneDir, 'data'), { recursive: true })
    writeFileSync(
      join(cloneDir, 'manifest.json'),
      JSON.stringify({ appId: 'ai-dev-progress-tracker' }),
    )
    writeFileSync(join(cloneDir, '.gitattributes'), BACKUP_GITATTRIBUTES)
    writeFileSync(join(cloneDir, 'data', 'backup-v1.json'), exportBackupData(ctx.db).dataJson)

    const enq = enqueueBackup(ctx.db, {
      trigger: 'pre_push',
      projectId,
      sourceCommitSha: headSha,
      backupRepo: 'x/y',
    })
    const run = getBackupRunById(ctx.db, enq.runId)
    if (run === null) {
      throw new Error('run missing')
    }
    const { deps, calls } = fakeGitDeps()

    await runBackup(ctx.db, run, {
      cloneDir,
      settleTimeoutMs: 300,
      settlePollMs: 20,
      ensureRepo: OK_ENSURE,
      git: deps,
    })

    const done = getBackupRunById(ctx.db, run.id)
    expect(done?.status).toBe('succeeded')
    expect(done?.backupCommitSha).toBe('HEAD_SHA_AAAA')
    expect(calls).not.toContain('commitPush')
    expect(calls).toContain('pull')
  })

  it('adds .gitattributes and re-pushes when an existing backup repo lacks it', async () => {
    const projectId = await register(ctx.db, { autoBackup: false })
    const headSha = repo.git('rev-parse', 'HEAD')

    // 前回 export と byte-identical だが `.gitattributes` が無い (この修正より前の repo)
    mkdirSync(join(cloneDir, '.git'), { recursive: true })
    mkdirSync(join(cloneDir, 'data'), { recursive: true })
    writeFileSync(
      join(cloneDir, 'manifest.json'),
      JSON.stringify({ appId: 'ai-dev-progress-tracker' }),
    )
    writeFileSync(join(cloneDir, 'data', 'backup-v1.json'), exportBackupData(ctx.db).dataJson)

    const enq = enqueueBackup(ctx.db, {
      trigger: 'pre_push',
      projectId,
      sourceCommitSha: headSha,
      backupRepo: 'fake-user/ai-dev-progress-tracker-backup',
    })
    const run = getBackupRunById(ctx.db, enq.runId)
    if (run === null) {
      throw new Error('run missing')
    }
    const { deps, calls } = fakeGitDeps()

    await runBackup(ctx.db, run, {
      cloneDir,
      settleTimeoutMs: 300,
      settlePollMs: 20,
      ensureRepo: OK_ENSURE,
      git: deps,
    })

    expect(getBackupRunById(ctx.db, run.id)?.status).toBe('succeeded')
    expect(calls).toContain('commitPush') // `.gitattributes` 追加のため commit する
    expect(existsSync(join(cloneDir, '.gitattributes'))).toBe(true)
    expect(readFileSync(join(cloneDir, '.gitattributes'), 'utf8')).toBe(BACKUP_GITATTRIBUTES)
  })
})
