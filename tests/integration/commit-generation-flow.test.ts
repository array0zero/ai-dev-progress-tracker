import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runHookCommit } from '../../src/cli/commands/hook-commit.js'
import type { Db } from '../../src/server/db/connection.js'
import { getLease } from '../../src/server/db/lease-repository.js'
import {
  getRunById,
  listRunsByProject,
  markRunTerminal,
  upsertCommit,
} from '../../src/server/db/run-repository.js'
import { enqueueGeneration, generationScope } from '../../src/server/services/generation-service.js'
import { registerProject } from '../../src/server/services/project-service.js'
import { processGenerationQueue } from '../../src/worker/generation-worker.js'
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
  const result = await registerProject({ name: slug, localPath: repo.root, repository: slug }, db)
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

describe('commit generation flow', () => {
  let ctx: TestDb
  let repo: TempRepo
  let fake: FakeGh

  beforeEach(() => {
    ctx = createTestDb()
    repo = createTempRepo({ origin: 'https://github.com/acme/widget.git' })
    fake = createFakeGh({
      authStatusExitCode: 0,
      repos: {
        'acme/widget': { repoView: repoView('NODE_ACME_WIDGET', 'acme/widget') },
        'acme/other': { repoView: repoView('NODE_ACME_OTHER', 'acme/other') },
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
})
