import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runHookCommit } from '../../src/cli/commands/hook-commit.js'
import { getCommit } from '../../src/server/adapters/git.js'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import type { Db } from '../../src/server/db/connection.js'
import { getLease } from '../../src/server/db/lease-repository.js'
import {
  countRunEvidence,
  getLatestSnapshotByProject,
  listRunEvidencePayloads,
} from '../../src/server/db/progress-repository.js'
import {
  getRunById,
  listRunsByProject,
  markRunTerminal,
  upsertCommit,
} from '../../src/server/db/run-repository.js'
import {
  collectEvidenceBundle,
  type EvidenceBundle,
  enqueueGeneration,
  generationScope,
  runGeneration,
} from '../../src/server/services/generation-service.js'
import { registerProject } from '../../src/server/services/project-service.js'
import { processGenerationQueue } from '../../src/worker/generation-worker.js'
import { createFakeCodex, type FakeCodex } from '../helpers/fake-codex.js'
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

async function registerTempProject(db: Db, repo: TempRepo, slug: string): Promise<string> {
  const result = await registerProject({ name: slug, localPath: repo.root, repository: slug }, db, {
    autoRecover: false,
    autoBackup: false,
  })
  if (!result.ok) {
    throw new Error(`registration failed: ${result.code}`)
  }
  return result.project.id
}

function hexSha(seed: number): string {
  return seed.toString(16).padStart(40, '0')
}

function seedCommit(db: Db, projectId: string, sha: string, detectedAt: string): void {
  upsertCommit(db, {
    projectId,
    sha,
    parentSha: null,
    message: `seed ${sha}`,
    authoredAt: detectedAt,
    detectedAt,
  })
}

async function seedCommitFromRepo(
  db: Db,
  projectId: string,
  repo: TempRepo,
  sha: string,
): Promise<void> {
  const meta = await getCommit(repo.root, sha)
  if (meta === null) {
    throw new Error(`commit ${sha} not found`)
  }
  const iso = new Date().toISOString()
  upsertCommit(db, {
    projectId,
    sha: meta.sha,
    parentSha: meta.parentSha,
    message: meta.message,
    authoredAt: meta.authoredAt !== '' ? meta.authoredAt : iso,
    detectedAt: iso,
  })
}

function evidenceId(bundle: EvidenceBundle, kind: 'commit' | 'issue' | 'pull_request'): string {
  const item = bundle.evidence.find((entry) => entry.kind === kind)
  if (item === undefined) {
    throw new Error(`no ${kind} evidence in bundle`)
  }
  return item.id
}

const needsInputText = { status: 'needs_input', text: '要補完', evidenceIds: [] }
const needsInputList = { status: 'needs_input', items: [], evidenceIds: [] }

function confirmedText(id: string): Record<string, unknown> {
  return { status: 'confirmed', text: '現在の作業内容', evidenceIds: [id] }
}
function confirmedList(id: string): Record<string, unknown> {
  return { status: 'confirmed', items: [{ text: '項目', evidenceIds: [id] }], evidenceIds: [id] }
}
function confirmedDecisions(id: string): Record<string, unknown> {
  return {
    status: 'confirmed',
    items: [{ decision: '採用', rationale: '理由', evidenceIds: [id] }],
    evidenceIds: [id],
  }
}

describe('commit generation flow', () => {
  let ctx: TestDb
  let repo: TempRepo
  let fake: FakeGh
  const codexFakes: FakeCodex[] = []

  function useFakeCodex(config: Parameters<typeof createFakeCodex>[0]): FakeCodex {
    const codex = createFakeCodex(config)
    codexFakes.push(codex)
    for (const [key, value] of Object.entries(codex.env)) {
      vi.stubEnv(key, value)
    }
    return codex
  }

  beforeEach(() => {
    ctx = createTestDb()
    repo = createTempRepo({ origin: 'https://github.com/acme/widget.git' })
    fake = createFakeGh({
      authStatusExitCode: 0,
      repos: {
        'acme/widget': {
          repoView: repoView('NODE_ACME_WIDGET', 'acme/widget'),
          issues: [
            {
              number: 11,
              title: 'Widget issue',
              state: 'OPEN',
              body: 'issue body for widget',
              updatedAt: '2026-08-01T00:00:00Z',
              url: 'https://github.com/acme/widget/issues/11',
              labels: [{ name: 'bug' }],
            },
          ],
          pulls: [
            {
              number: 21,
              title: 'Widget PR',
              state: 'OPEN',
              body: 'pr body for widget',
              updatedAt: '2026-08-02T00:00:00Z',
              mergedAt: null,
              url: 'https://github.com/acme/widget/pull/21',
              headRefName: 'feat',
              baseRefName: 'main',
            },
          ],
        },
        'acme/other': {
          repoView: repoView('NODE_ACME_OTHER', 'acme/other'),
          issues: [
            {
              number: 99,
              title: 'OTHER_REPO_LEAK',
              state: 'OPEN',
              body: 'should never appear in acme/widget bundle',
              updatedAt: '2026-08-03T00:00:00Z',
              url: 'https://github.com/acme/other/issues/99',
              labels: [],
            },
          ],
        },
      },
    })
    for (const [key, value] of Object.entries(fake.env)) {
      vi.stubEnv(key, value)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    while (codexFakes.length > 0) {
      codexFakes.pop()?.cleanup()
    }
    fake.cleanup()
    repo.cleanup()
    ctx.cleanup()
  })

  it('queues exactly one generation run when the same commit is enqueued 10 times', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const sha = hexSha(0xabc)
    seedCommit(ctx.db, projectId, sha, '2026-09-01T00:00:00.000Z')

    for (let i = 0; i < 10; i += 1) {
      enqueueGeneration(ctx.db, {
        projectId,
        sha,
        mode: 'generation',
        trigger: 'post_commit',
      })
    }

    const runs = listRunsByProject(ctx.db, projectId)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.dedupeKey).toBe(`generation:${projectId}:${sha}`)
  })

  it('treats the same SHA string in a different project as a separate run', async () => {
    const projectA = await registerTempProject(ctx.db, repo, 'acme/widget')
    const repoB = createTempRepo({ origin: 'https://github.com/acme/other.git' })
    try {
      const projectB = await registerTempProject(ctx.db, repoB, 'acme/other')
      const sha = hexSha(0x1234)
      seedCommit(ctx.db, projectA, sha, '2026-09-01T00:00:00.000Z')
      seedCommit(ctx.db, projectB, sha, '2026-09-01T00:00:00.000Z')

      const a = enqueueGeneration(ctx.db, {
        projectId: projectA,
        sha,
        mode: 'generation',
        trigger: 'post_commit',
      })
      const b = enqueueGeneration(ctx.db, {
        projectId: projectB,
        sha,
        mode: 'generation',
        trigger: 'post_commit',
      })

      expect(a.runId).not.toBe(b.runId)
      expect(listRunsByProject(ctx.db, projectA)).toHaveLength(1)
      expect(listRunsByProject(ctx.db, projectB)).toHaveLength(1)
    } finally {
      repoB.cleanup()
    }
  })

  it('holds a single lease for three runs and processes them in enqueue order', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const scope = generationScope(projectId)
    const base = Date.parse('2026-09-01T00:00:00.000Z')

    const results = [0, 1, 2].map((offset) => {
      const sha = hexSha(0x100 + offset)
      seedCommit(ctx.db, projectId, sha, new Date(base + offset * 1000).toISOString())
      return enqueueGeneration(
        ctx.db,
        { projectId, sha, mode: 'generation', trigger: 'post_commit' },
        () => new Date(base + offset * 1000),
      )
    })

    expect(results[0]?.shouldSpawn).toBe(true)
    expect(results[1]?.shouldSpawn).toBe(false)
    expect(results[2]?.shouldSpawn).toBe(false)
    expect(getLease(ctx.db, scope)).not.toBeNull()

    const processed: string[] = []
    const token = results[0]?.ownerToken ?? ''
    await processGenerationQueue(ctx.db, scope, token, {
      maxIterations: 20,
      process: async (db, run) => {
        processed.push(run.id)
        markRunTerminal(db, run.id, 'succeeded')
      },
    })

    expect(processed).toEqual([results[0]?.runId, results[1]?.runId, results[2]?.runId])
    for (const result of results) {
      expect(getRunById(ctx.db, result.runId ?? '')?.startedAt).not.toBeNull()
    }
    expect(getLease(ctx.db, scope)).toBeNull()
  })

  it('does not drop a run enqueued while the queue is being drained', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const scope = generationScope(projectId)
    const shaA = hexSha(0x2a)
    const shaB = hexSha(0x2b)
    seedCommit(ctx.db, projectId, shaA, '2026-09-01T00:00:00.000Z')
    seedCommit(ctx.db, projectId, shaB, '2026-09-01T00:00:05.000Z')

    const first = enqueueGeneration(ctx.db, {
      projectId,
      sha: shaA,
      mode: 'generation',
      trigger: 'post_commit',
    })

    await processGenerationQueue(ctx.db, scope, first.ownerToken ?? '', {
      maxIterations: 20,
      process: async (db, run) => {
        markRunTerminal(db, run.id, 'succeeded')
        if (run.id === first.runId) {
          enqueueGeneration(db, {
            projectId,
            sha: shaB,
            mode: 'generation',
            trigger: 'post_commit',
          })
        }
      },
    })

    const runs = listRunsByProject(ctx.db, projectId)
    expect(runs).toHaveLength(2)
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true)
    expect(getLease(ctx.db, scope)).toBeNull()
  })

  it('hook-commit returns within 2s, queues a run and asks to spawn one worker', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    writeFileSync(join(repo.root, 'CHANGE.md'), '# change\n')
    repo.git('add', '.')
    repo.git('commit', '-m', 'second commit')
    const headSha = repo.git('rev-parse', 'HEAD')

    const spawnCalls: Array<[string, string]> = []
    const startedAt = Date.now()
    const code = await runHookCommit(
      { projectId, repo: repo.root, sha: headSha },
      { db: ctx.db, spawnWorker: (scope, token) => spawnCalls.push([scope, token]) },
    )

    expect(code).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(2000)
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.[0]).toBe(generationScope(projectId))

    const runs = listRunsByProject(ctx.db, projectId)
    expect(runs.some((run) => run.commitSha === headSha && run.status === 'queued')).toBe(true)
  })

  it('releases the lease and fails the origin run when the worker cannot be spawned', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    writeFileSync(join(repo.root, 'CHANGE.md'), '# change\n')
    repo.git('add', '.')
    repo.git('commit', '-m', 'second commit')
    const headSha = repo.git('rev-parse', 'HEAD')

    await runHookCommit(
      { projectId, repo: repo.root, sha: headSha },
      {
        db: ctx.db,
        spawnWorker: () => {
          throw new Error('spawn boom')
        },
      },
    )

    const run = listRunsByProject(ctx.db, projectId).find((item) => item.commitSha === headSha)
    expect(run?.status).toBe('failed')
    expect(run?.errorCode).toBe('WORKER_SPAWN_FAILED')
    expect(getLease(ctx.db, generationScope(projectId))).toBeNull()
  })

  it('builds an evidence bundle from the single project repo only, capped and redacted', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')

    writeFileSync(join(repo.root, 'big.txt'), 'x'.repeat(200_000))
    writeFileSync(
      join(repo.root, 'notes.txt'),
      'leaked key ghp_0123456789abcdefghijABCDEFGHIJKL end\n',
    )
    repo.git('add', '.')
    repo.git('commit', '-m', 'add big file and a token ghp_0123456789abcdefghijABCDEFGHIJKL')
    const headSha = repo.git('rev-parse', 'HEAD')
    await seedCommitFromRepo(ctx.db, projectId, repo, headSha)

    const enqueued = enqueueGeneration(ctx.db, {
      projectId,
      sha: headSha,
      mode: 'generation',
      trigger: 'post_commit',
    })
    const run = getRunById(ctx.db, enqueued.runId)
    if (run === null) {
      throw new Error('run missing')
    }

    const bundle = await collectEvidenceBundle(ctx.db, run)

    const kinds = bundle.evidence.map((item) => item.kind).sort()
    expect(kinds).toEqual(['commit', 'issue', 'pull_request'])
    expect(countRunEvidence(ctx.db, run.id)).toBe(bundle.evidence.length)

    const serialized = JSON.stringify(bundle.evidence)
    expect(serialized).not.toContain('OTHER_REPO_LEAK')
    expect(serialized).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJKL')
    expect(serialized).toContain('[REDACTED]')

    const commitItem = bundle.evidence.find((item) => item.kind === 'commit')
    const payload = commitItem?.payload as { patch: string; truncated: boolean }
    expect(payload.patch.length).toBeLessThanOrEqual(120_000)
    expect(payload.truncated).toBe(true)

    const persisted = JSON.stringify(listRunEvidencePayloads(ctx.db, run.id))
    expect(persisted).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJKL')
    expect(persisted).not.toContain('OTHER_REPO_LEAK')
  })

  async function seedRunForHead(projectId: string, detectedAt?: string): Promise<string> {
    writeFileSync(join(repo.root, `f-${Date.now()}-${Math.random()}.txt`), 'change\n')
    repo.git('add', '.')
    repo.git('commit', '-m', 'a commit')
    const headSha = repo.git('rev-parse', 'HEAD')
    await seedCommitFromRepo(ctx.db, projectId, repo, headSha)
    if (detectedAt !== undefined) {
      ctx.db
        .prepare('UPDATE commits SET detected_at = ? WHERE project_id = ? AND sha = ?')
        .run(detectedAt, projectId, headSha)
    }
    const enqueued = enqueueGeneration(ctx.db, {
      projectId,
      sha: headSha,
      mode: 'generation',
      trigger: 'post_commit',
    })
    return enqueued.runId
  }

  it('saves a complete snapshot and marks the run succeeded for 4/4 confirmed output', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const runId = await seedRunForHead(projectId)
    const run = getRunById(ctx.db, runId)
    if (run === null) {
      throw new Error('run missing')
    }
    const bundle = await collectEvidenceBundle(ctx.db, run)
    const ev = evidenceId(bundle, 'commit')

    useFakeCodex({
      output: {
        schemaVersion: 1,
        currentPosition: confirmedText(ev),
        completedItems: confirmedList(ev),
        nextActions: confirmedList(ev),
        importantDecisions: confirmedDecisions(ev),
      },
    })

    await runGeneration(ctx.db, run)

    expect(getRunById(ctx.db, runId)?.status).toBe('succeeded')
    const snapshot = getLatestSnapshotByProject(ctx.db, projectId)
    expect(snapshot?.recoveryStatus).toBe('complete')
    expect(snapshot?.currentPosition).toMatchObject({ status: 'confirmed' })
  })

  it('marks the run partial for a 3 confirmed + 1 needs_input output', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const runId = await seedRunForHead(projectId)
    const run = getRunById(ctx.db, runId)
    if (run === null) {
      throw new Error('run missing')
    }
    const ev = evidenceId(await collectEvidenceBundle(ctx.db, run), 'commit')

    useFakeCodex({
      output: {
        schemaVersion: 1,
        currentPosition: confirmedText(ev),
        completedItems: confirmedList(ev),
        nextActions: confirmedList(ev),
        importantDecisions: needsInputList,
      },
    })

    await runGeneration(ctx.db, run)

    expect(getRunById(ctx.db, runId)?.status).toBe('partial')
    expect(getLatestSnapshotByProject(ctx.db, projectId)?.recoveryStatus).toBe('partial')
  })

  it('marks the run unrecoverable for a 0 confirmed output', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const runId = await seedRunForHead(projectId)
    const run = getRunById(ctx.db, runId)
    if (run === null) {
      throw new Error('run missing')
    }
    useFakeCodex({
      output: {
        schemaVersion: 1,
        currentPosition: needsInputText,
        completedItems: needsInputList,
        nextActions: needsInputList,
        importantDecisions: needsInputList,
      },
    })

    await runGeneration(ctx.db, run)

    expect(getRunById(ctx.db, runId)?.status).toBe('unrecoverable')
    expect(getLatestSnapshotByProject(ctx.db, projectId)?.recoveryStatus).toBe('unrecoverable')
  })

  it('does not create a snapshot when Codex exits non-zero', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const runId = await seedRunForHead(projectId)
    const run = getRunById(ctx.db, runId)
    if (run === null) {
      throw new Error('run missing')
    }
    useFakeCodex({ execExitCode: 1 })

    await runGeneration(ctx.db, run)

    expect(getRunById(ctx.db, runId)?.status).toBe('failed')
    expect(getLatestSnapshotByProject(ctx.db, projectId)).toBeNull()
  })

  it('does not treat invalid JSON output as success', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const runId = await seedRunForHead(projectId)
    const run = getRunById(ctx.db, runId)
    if (run === null) {
      throw new Error('run missing')
    }
    useFakeCodex({ outputRaw: '{ not json' })

    await runGeneration(ctx.db, run)

    expect(getRunById(ctx.db, runId)?.status).toBe('failed')
    expect(getLatestSnapshotByProject(ctx.db, projectId)).toBeNull()
  })

  it('keeps the newest commit reflected when an older commit run completes later', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')

    const oldRunId = await seedRunForHead(projectId, '2026-09-01T00:00:00.000Z')
    const newRunId = await seedRunForHead(projectId, '2026-09-02T00:00:00.000Z')
    const oldRun = getRunById(ctx.db, oldRunId)
    const newRun = getRunById(ctx.db, newRunId)
    if (oldRun === null || newRun === null) {
      throw new Error('run missing')
    }

    const newEv = evidenceId(await collectEvidenceBundle(ctx.db, newRun), 'commit')
    useFakeCodex({
      output: {
        schemaVersion: 1,
        currentPosition: confirmedText(newEv),
        completedItems: confirmedList(newEv),
        nextActions: confirmedList(newEv),
        importantDecisions: confirmedDecisions(newEv),
      },
    })
    await runGeneration(ctx.db, newRun)
    const reflectedAfterNew = getLatestSnapshotByProject(ctx.db, projectId)?.commitSha

    const oldEv = evidenceId(await collectEvidenceBundle(ctx.db, oldRun), 'commit')
    useFakeCodex({
      output: {
        schemaVersion: 1,
        currentPosition: confirmedText(oldEv),
        completedItems: confirmedList(oldEv),
        nextActions: confirmedList(oldEv),
        importantDecisions: confirmedDecisions(oldEv),
      },
    })
    await runGeneration(ctx.db, oldRun)

    expect(getLatestSnapshotByProject(ctx.db, projectId)?.commitSha).toBe(reflectedAfterNew)
    expect(getLatestSnapshotByProject(ctx.db, projectId)?.commitSha).toBe(newRun.commitSha)
  })

  it('does not add a generation run when the same commit is re-triggered (push shape)', async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const runId = await seedRunForHead(projectId)
    const run = getRunById(ctx.db, runId)
    if (run === null) {
      throw new Error('run missing')
    }
    const ev = evidenceId(await collectEvidenceBundle(ctx.db, run), 'commit')
    useFakeCodex({
      output: {
        schemaVersion: 1,
        currentPosition: confirmedText(ev),
        completedItems: confirmedList(ev),
        nextActions: confirmedList(ev),
        importantDecisions: confirmedDecisions(ev),
      },
    })
    await runGeneration(ctx.db, run)
    const countAfterGeneration = listRunsByProject(ctx.db, projectId).length

    // push で同一 commit が再び enqueue されても run 数は増えない
    enqueueGeneration(ctx.db, {
      projectId,
      sha: run.commitSha,
      mode: 'generation',
      trigger: 'post_commit',
    })
    expect(listRunsByProject(ctx.db, projectId).length).toBe(countAfterGeneration)
  })

  it('starts each of 10 sequential commit runs within 5s of detection', {
    timeout: 60_000,
  }, async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const scope = generationScope(projectId)
    useFakeCodex({
      output: {
        schemaVersion: 1,
        currentPosition: needsInputText,
        completedItems: needsInputList,
        nextActions: needsInputList,
        importantDecisions: needsInputList,
      },
    })

    let token = ''
    for (let i = 0; i < 10; i += 1) {
      writeFileSync(join(repo.root, `seq-${i}.txt`), `${i}\n`)
      repo.git('add', '.')
      repo.git('commit', '-m', `seq ${i}`)
      const headSha = repo.git('rev-parse', 'HEAD')
      await seedCommitFromRepo(ctx.db, projectId, repo, headSha)
      const enqueued = enqueueGeneration(ctx.db, {
        projectId,
        sha: headSha,
        mode: 'generation',
        trigger: 'post_commit',
      })
      if (enqueued.ownerToken !== null) {
        token = enqueued.ownerToken
      }
    }

    await processGenerationQueue(ctx.db, scope, token, { maxIterations: 50 })

    const runs = listRunsByProject(ctx.db, projectId)
    expect(runs).toHaveLength(10)
    for (const run of runs) {
      expect(['queued', 'running']).not.toContain(run.status)
      const started = getRunById(ctx.db, run.id)?.startedAt
      expect(started).not.toBeNull()
      const latencyMs = Date.parse(started ?? '') - Date.parse(run.detectedAt)
      expect(latencyMs).toBeLessThanOrEqual(5000)
    }
  })

  it('never marks a run succeeded for any of the three silent-failure shapes', {
    timeout: 30_000,
  }, async () => {
    const projectId = await registerTempProject(ctx.db, repo, 'acme/widget')
    const shapes: Array<Parameters<typeof createFakeCodex>[0]> = [
      { execExitCode: 1 },
      { outputRaw: '{ not json' },
      {
        output: {
          schemaVersion: 1,
          currentPosition: confirmedText('00000000-0000-0000-0000-000000000000'),
          completedItems: needsInputList,
          nextActions: needsInputList,
          importantDecisions: needsInputList,
        },
      },
    ]

    const outcomes: string[] = []
    for (const shape of shapes) {
      const runId = await seedRunForHead(projectId)
      const run = getRunById(ctx.db, runId)
      if (run === null) {
        throw new Error('run missing')
      }
      const codex = createFakeCodex(shape)
      codexFakes.push(codex)
      for (const [key, value] of Object.entries(codex.env)) {
        vi.stubEnv(key, value)
      }
      await runGeneration(ctx.db, run)
      outcomes.push(getRunById(ctx.db, runId)?.status ?? 'missing')
      expect(getLatestSnapshotByProject(ctx.db, projectId)).toBeNull()
    }

    expect(outcomes).toEqual(['failed', 'failed', 'failed'])
  })

  it('starts and stops a server on the test data dir 10 times', { timeout: 30_000 }, async () => {
    for (let i = 0; i < 10; i += 1) {
      const app = await buildApp({ config: loadConfig({ TRACKER_DATA_DIR: '' }), db: ctx.db })
      await app.listen({ host: '127.0.0.1', port: 0 })
      const response = await app.inject({ method: 'GET', url: '/api/health' })
      expect(response.statusCode).toBe(200)
      await app.close()
    }
  })
})
