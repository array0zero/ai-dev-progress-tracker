import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginRegistration,
  getCandidate,
  listCandidates,
  upsertDetected,
} from '../../src/server/db/candidate-repository.js'
import { listProjects } from '../../src/server/db/project-repository.js'
import {
  REGISTRATION_RETRY_DELAY_MS,
  runRegistrationCycle,
} from '../../src/server/services/registration-service.js'
import { processRegistrationQueue } from '../../src/worker/registration-worker.js'
import { createFakeGh, type FakeGh } from '../helpers/fake-gh.js'
import { createTempDir, type TempDir } from '../helpers/temp-repo.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

describe('registration retry', () => {
  let ctx: TestDb
  let fake: FakeGh
  let remoteDir: string
  let folder: TempDir

  function fixtures(): Record<string, unknown> {
    return JSON.parse(readFileSync(fake.env.FAKE_GH_FIXTURES ?? '', 'utf8')) as Record<
      string,
      unknown
    >
  }

  function setRepoCreateExitCode(code: number): void {
    writeFileSync(
      fake.env.FAKE_GH_FIXTURES ?? '',
      JSON.stringify({ ...fixtures(), repoCreateExitCode: code }),
    )
  }

  function createCalls(): string[][] {
    return fake.calls().filter((call) => call[0] === 'repo' && call[1] === 'create')
  }

  function approve(name = 'Retry Project'): string {
    const candidate = upsertDetected(ctx.db, {
      localPath: folder.root,
      agent: 'codex',
      suggestedName: name,
    })
    beginRegistration(ctx.db, candidate.id)
    return candidate.id
  }

  beforeEach(() => {
    ctx = createTestDb()
    folder = createTempDir('adpt-retry-')
    remoteDir = mkdtempSync(join(tmpdir(), 'adpt-retry-remotes-'))
    fake = createFakeGh({
      authStatusExitCode: 0,
      login: 'octocat',
      createRemoteDir: remoteDir,
      repoCreateExitCode: 1,
    })
    for (const [key, value] of Object.entries(fake.env)) {
      vi.stubEnv(key, value)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fake.cleanup()
    folder.cleanup()
    rmSync(remoteDir, { recursive: true, force: true })
    ctx.cleanup()
  })

  it('keeps the fixed retry contract: initial attempt plus exactly one retry after 2 seconds', () => {
    expect(REGISTRATION_RETRY_DELAY_MS).toBe(2_000)
  })

  it('recovers on the second attempt without any extra user action', async () => {
    const candidateId = approve()
    let waited = 0

    await runRegistrationCycle(ctx.db, candidateId, {
      autoRecover: false,
      autoBackup: false,
      sleep: async (ms) => {
        waited = ms
        // 待っている間に外部側が復旧する
        setRepoCreateExitCode(0)
      },
    })

    expect(waited).toBe(REGISTRATION_RETRY_DELAY_MS)
    expect(createCalls()).toHaveLength(2)
    const candidate = getCandidate(ctx.db, candidateId)
    expect(candidate).toMatchObject({ status: 'registered', attemptCount: 2 })
    expect(listProjects(ctx.db)).toHaveLength(1)
    expect(candidate?.projectId).toBe(listProjects(ctx.db)[0]?.id)
  })

  it('marks the candidate failed after two attempts and never tries a third time', async () => {
    const candidateId = approve()

    await runRegistrationCycle(ctx.db, candidateId, {
      autoRecover: false,
      autoBackup: false,
      sleep: async () => undefined,
    })

    expect(createCalls()).toHaveLength(2)
    expect(getCandidate(ctx.db, candidateId)).toMatchObject({
      status: 'failed',
      attemptCount: 2,
      lastErrorCode: 'GITHUB_REPOSITORY_CREATE_FAILED',
    })
    expect(listProjects(ctx.db)).toEqual([])

    // 追加で worker が回っても 3 回目は起きない
    await processRegistrationQueue(ctx.db, {
      autoRecover: false,
      autoBackup: false,
      sleep: async () => undefined,
    })
    expect(createCalls()).toHaveLength(2)
    expect(getCandidate(ctx.db, candidateId)?.attemptCount).toBe(2)
  })

  it('runs only the remaining attempt when a worker restarts after attempt 1', async () => {
    const candidateId = approve()
    // attempt 1 だけを実行して worker が落ちた状態を作る
    await runRegistrationCycle(ctx.db, candidateId, {
      autoRecover: false,
      autoBackup: false,
      sleep: async () => {
        throw new Error('worker crashed before the retry')
      },
    }).catch(() => undefined)
    expect(createCalls()).toHaveLength(1)
    expect(getCandidate(ctx.db, candidateId)).toMatchObject({
      status: 'registering',
      attemptCount: 1,
      lastErrorCode: 'GITHUB_REPOSITORY_CREATE_FAILED',
    })

    setRepoCreateExitCode(0)
    await processRegistrationQueue(ctx.db, {
      autoRecover: false,
      autoBackup: false,
      sleep: async () => undefined,
    })

    expect(createCalls()).toHaveLength(2)
    expect(getCandidate(ctx.db, candidateId)).toMatchObject({
      status: 'registered',
      attemptCount: 2,
    })

    // 復旧後にもう一度 worker が回っても attempt は増えない
    await processRegistrationQueue(ctx.db, { autoRecover: false, autoBackup: false })
    expect(createCalls()).toHaveLength(2)
  })

  it('keeps failed candidates listed and resets the cycle on reopen', async () => {
    const candidateId = approve()
    await runRegistrationCycle(ctx.db, candidateId, {
      autoRecover: false,
      autoBackup: false,
      sleep: async () => undefined,
    })
    expect(listCandidates(ctx.db, 'failed').map((candidate) => candidate.id)).toEqual([candidateId])

    ctx.db
      .prepare(
        "UPDATE registration_candidates SET status = 'detected', attempt_count = 0, last_error_code = NULL, last_error_message = NULL, decision_at = NULL WHERE id = ?",
      )
      .run(candidateId)
    setRepoCreateExitCode(0)
    expect(beginRegistration(ctx.db, candidateId)).toBe(true)
    await runRegistrationCycle(ctx.db, candidateId, {
      autoRecover: false,
      autoBackup: false,
      sleep: async () => undefined,
    })
    expect(getCandidate(ctx.db, candidateId)).toMatchObject({
      status: 'registered',
      attemptCount: 1,
    })
  })

  it('is a no-op when there is nothing to retry', async () => {
    await expect(
      processRegistrationQueue(ctx.db, { autoRecover: false, autoBackup: false }),
    ).resolves.toBeUndefined()
    expect(createCalls()).toEqual([])
    expect(listCandidates(ctx.db)).toEqual([])
  })

  it('reports the registered project through the repository read back', async () => {
    setRepoCreateExitCode(0)
    const candidateId = approve('Readback Project')
    await runRegistrationCycle(ctx.db, candidateId, {
      autoRecover: false,
      autoBackup: false,
      sleep: async () => undefined,
    })

    const project = listProjects(ctx.db)[0]
    expect(project).toMatchObject({ name: 'Readback Project', repoName: 'readback-project' })
    const origin = execFileSync(
      'git',
      ['-C', project?.localPath ?? '', 'remote', 'get-url', 'origin'],
      { encoding: 'utf8' },
    ).trim()
    expect(origin).toContain('octocat__readback-project.git')
  })
})
