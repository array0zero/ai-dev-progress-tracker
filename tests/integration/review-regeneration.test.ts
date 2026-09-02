import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import { getLatestSnapshotByProject } from '../../src/server/db/progress-repository.js'
import { getProjectById, insertProject } from '../../src/server/db/project-repository.js'
import { getRunById, upsertCommit } from '../../src/server/db/run-repository.js'
import {
  collectEvidenceBundle,
  runGeneration,
} from '../../src/server/services/generation-service.js'
import { registerProject } from '../../src/server/services/project-service.js'
import { createFakeCodex, type FakeCodex } from '../helpers/fake-codex.js'
import { createFakeGh } from '../helpers/fake-gh.js'
import { createTempRepo } from '../helpers/temp-repo.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

const SHA = 'e'.repeat(40)

function progressOutput(evidenceId: string): unknown {
  const confirmedList = {
    status: 'confirmed',
    items: [{ text: '再生成された作業', evidenceIds: [evidenceId] }],
    evidenceIds: [evidenceId],
  }
  return {
    schemaVersion: 1,
    currentPosition: { status: 'confirmed', text: '再生成後の現在地', evidenceIds: [evidenceId] },
    completedItems: confirmedList,
    nextActions: confirmedList,
    importantDecisions: {
      status: 'confirmed',
      items: [{ decision: 'd', rationale: 'r', evidenceIds: [evidenceId] }],
      evidenceIds: [evidenceId],
    },
  }
}

describe('review flag and regeneration', () => {
  let ctx: TestDb
  let fake: FakeCodex | null = null

  function seedProject(withCommit = true): string {
    const id = randomUUID()
    insertProject(ctx.db, {
      id,
      name: 'review demo',
      localPath: `/review/${id}`,
      repoNodeId: `NODE_${id}`,
      repoOwner: 'octo',
      repoName: 'demo',
      repoUrl: 'https://github.com/octo/demo',
      defaultBranch: 'main',
      status: 'active',
    })
    if (withCommit) {
      upsertCommit(ctx.db, {
        projectId: id,
        sha: SHA,
        parentSha: null,
        message: 'seed',
        authoredAt: '2026-09-02T00:00:00.000Z',
        detectedAt: '2026-09-02T00:00:01.000Z',
      })
    }
    return id
  }

  async function withApp<T>(action: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<T>) {
    const app = await buildApp({ config: loadConfig({ TRACKER_DATA_DIR: '' }), db: ctx.db })
    try {
      return await action(app)
    } finally {
      await app.close()
    }
  }

  beforeEach(() => {
    ctx = createTestDb()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fake?.cleanup()
    fake = null
    ctx.cleanup()
  })

  it('sets and clears the review flag and reads the same value back', async () => {
    const projectId = seedProject()

    const set = await withApp((app) =>
      app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/review`,
        payload: { required: true },
      }),
    )
    expect(set.statusCode).toBe(200)
    const body = set.json() as { reviewRequired: boolean; reviewRequiredAt: string | null }
    expect(body.reviewRequired).toBe(true)
    expect(body.reviewRequiredAt).not.toBeNull()

    const readBack = await withApp((app) =>
      app.inject({ method: 'GET', url: `/api/projects/${projectId}` }),
    )
    expect((readBack.json() as { reviewRequired: boolean }).reviewRequired).toBe(true)

    const cleared = await withApp((app) =>
      app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/review`,
        payload: { required: false },
      }),
    )
    expect(cleared.json()).toMatchObject({ reviewRequired: false, reviewRequiredAt: null })
    expect(getProjectById(ctx.db, projectId)?.reviewRequiredAt).toBeNull()
  })

  it('rejects an invalid body and an unknown project', async () => {
    const projectId = seedProject()
    const invalid = await withApp((app) =>
      app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/review`,
        payload: { required: 'yes' },
      }),
    )
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } })

    const missing = await withApp((app) =>
      app.inject({
        method: 'PATCH',
        url: '/api/projects/does-not-exist/review',
        payload: { required: true },
      }),
    )
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } })
  })

  it('does not start regeneration for a project without a HEAD but still allows the review flag', async () => {
    const projectId = seedProject(false)

    const recover = await withApp((app) =>
      app.inject({ method: 'POST', url: `/api/projects/${projectId}/recover` }),
    )
    expect(recover.statusCode).toBe(422)
    expect(recover.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
    expect(
      ctx.db
        .prepare('SELECT COUNT(*) FROM generation_runs WHERE project_id = ?')
        .pluck()
        .get(projectId),
    ).toBe(0)

    const review = await withApp((app) =>
      app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/review`,
        payload: { required: true },
      }),
    )
    expect(review.statusCode).toBe(200)
    expect(getProjectById(ctx.db, projectId)?.reviewRequired).toBe(true)
  })

  it('keeps reviewRequired true after a successful manual regeneration', async () => {
    const repo = createTempRepo({ origin: 'https://github.com/acme/widget.git' })
    const gh = createFakeGh({
      authStatusExitCode: 0,
      repos: {
        'acme/widget': {
          repoView: {
            id: 'NODE_ACME_WIDGET',
            nameWithOwner: 'acme/widget',
            url: 'https://github.com/acme/widget',
            visibility: 'PRIVATE',
            defaultBranchRef: { name: 'main' },
          },
          issues: [],
          pulls: [],
        },
      },
    })
    for (const [key, value] of Object.entries(gh.env)) {
      vi.stubEnv(key, value)
    }

    try {
      const registered = await registerProject(
        { name: 'Review Demo', localPath: repo.root, repository: 'acme/widget' },
        ctx.db,
        { autoRecover: false, autoBackup: false },
      )
      expect(registered.ok).toBe(true)
      if (!registered.ok) {
        return
      }
      const projectId = registered.project.id
      const headSha = repo.git('rev-parse', 'HEAD')

      await withApp((app) =>
        app.inject({
          method: 'PATCH',
          url: `/api/projects/${projectId}/review`,
          payload: { required: true },
        }),
      )

      // UI の「再生成」と同じ経路
      const queued = await withApp((app) =>
        app.inject({ method: 'POST', url: `/api/projects/${projectId}/recover` }),
      )
      expect(queued.statusCode).toBe(202)
      const runId = (queued.json() as { runId: string }).runId
      const run = getRunById(ctx.db, runId)
      expect(run).toMatchObject({ mode: 'recovery', trigger: 'manual_recovery' })
      if (run === null) {
        return
      }

      const bundle = await collectEvidenceBundle(ctx.db, run)
      const evidenceId = bundle.evidence.find((item) => item.kind === 'commit')?.id ?? ''
      expect(evidenceId).not.toBe('')

      fake = createFakeCodex({ output: progressOutput(evidenceId) })
      for (const [key, value] of Object.entries(fake.env)) {
        vi.stubEnv(key, value)
      }

      await runGeneration(ctx.db, { ...run, status: 'running' })

      const finished = getRunById(ctx.db, runId)
      expect([finished?.status, finished?.errorCode]).toEqual(['succeeded', null])
      // fake Codex 出力を保存したあと、再取得した snapshot の commit SHA は入力 HEAD と一致する
      expect(getLatestSnapshotByProject(ctx.db, projectId)?.commitSha).toBe(headSha)
      // 成功しても要確認は自動解除されない (DESIGN D012)
      expect(getProjectById(ctx.db, projectId)?.reviewRequired).toBe(true)

      const detail = await withApp((app) =>
        app.inject({ method: 'GET', url: `/api/projects/${projectId}` }),
      )
      expect(detail.json()).toMatchObject({
        reviewRequired: true,
        currentPosition: '再生成後の現在地',
      })
    } finally {
      gh.cleanup()
      repo.cleanup()
    }
  })
})
