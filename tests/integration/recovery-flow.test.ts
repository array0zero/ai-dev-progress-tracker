import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import type { Db } from '../../src/server/db/connection.js'
import { getLatestSnapshotByProject } from '../../src/server/db/progress-repository.js'
import { getRunById, listRunsByProject } from '../../src/server/db/run-repository.js'
import {
  collectEvidenceBundle,
  type EvidenceBundle,
  runGeneration,
} from '../../src/server/services/generation-service.js'
import { registerProject } from '../../src/server/services/project-service.js'
import { enqueueRecovery } from '../../src/server/services/recovery-service.js'
import { createFakeCodex, type FakeCodex } from '../helpers/fake-codex.js'
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

function commitEvidenceId(bundle: EvidenceBundle): string {
  const item = bundle.evidence.find((entry) => entry.kind === 'commit')
  if (item === undefined) {
    throw new Error('no commit evidence')
  }
  return item.id
}

const confirmedText = (id: string) => ({
  status: 'confirmed',
  text: '現在の作業',
  evidenceIds: [id],
})
const confirmedList = (id: string) => ({
  status: 'confirmed',
  items: [{ text: '項目', evidenceIds: [id] }],
  evidenceIds: [id],
})
const confirmedDecisions = (id: string) => ({
  status: 'confirmed',
  items: [{ decision: '採用', rationale: '理由', evidenceIds: [id] }],
  evidenceIds: [id],
})
const needsInputList = { status: 'needs_input', items: [], evidenceIds: [] }
const needsInputText = { status: 'needs_input', text: '要補完', evidenceIds: [] }

describe('recovery flow', () => {
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

  async function register(db: Db): Promise<string> {
    const result = await registerProject(
      { name: 'acme/widget', localPath: repo.root, repository: 'acme/widget' },
      db,
      { autoBackup: false, spawnWorker: () => undefined },
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
      repos: { 'acme/widget': { repoView: repoView('acme/widget'), issues: [], pulls: [] } },
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

  it('auto-enqueues a recovery run when a project is registered without a snapshot', async () => {
    const projectId = await register(ctx.db)
    const runs = listRunsByProject(ctx.db, projectId)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.mode).toBe('recovery')
    expect(runs[0]?.trigger).toBe('registration')
    expect(runs[0]?.status).toBe('queued')
  })

  it('rejects a manual recovery while a run is already active', async () => {
    const projectId = await register(ctx.db)
    const result = enqueueRecovery(ctx.db, projectId, 'manual_recovery')
    expect(result).toMatchObject({ ok: false, status: 409, code: 'RUN_ALREADY_ACTIVE' })
  })

  it('classifies a fully evidenced recovery as complete', async () => {
    const projectId = await register(ctx.db)
    const run = getRunById(ctx.db, listRunsByProject(ctx.db, projectId)[0]?.id ?? '')
    if (run === null) {
      throw new Error('run missing')
    }
    const ev = commitEvidenceId(await collectEvidenceBundle(ctx.db, run))
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

    expect(getRunById(ctx.db, run.id)?.status).toBe('succeeded')
    expect(getLatestSnapshotByProject(ctx.db, projectId)?.recoveryStatus).toBe('complete')
  })

  it('marks one unevidenced field as 要補完 and the run partial, without storing a concrete value', async () => {
    const projectId = await register(ctx.db)
    const run = getRunById(ctx.db, listRunsByProject(ctx.db, projectId)[0]?.id ?? '')
    if (run === null) {
      throw new Error('run missing')
    }
    const ev = commitEvidenceId(await collectEvidenceBundle(ctx.db, run))
    useFakeCodex({
      output: {
        schemaVersion: 1,
        currentPosition: needsInputText,
        completedItems: confirmedList(ev),
        nextActions: confirmedList(ev),
        importantDecisions: confirmedDecisions(ev),
      },
    })

    await runGeneration(ctx.db, run)

    expect(getRunById(ctx.db, run.id)?.status).toBe('partial')
    const snapshot = getLatestSnapshotByProject(ctx.db, projectId)
    expect(snapshot?.recoveryStatus).toBe('partial')
    expect(snapshot?.currentPosition).toEqual({
      status: 'needs_input',
      text: '要補完',
      evidenceIds: [],
    })
  })

  it('classifies a recovery with no evidenced field as unrecoverable', async () => {
    const projectId = await register(ctx.db)
    const run = getRunById(ctx.db, listRunsByProject(ctx.db, projectId)[0]?.id ?? '')
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

    expect(getRunById(ctx.db, run.id)?.status).toBe('unrecoverable')
    expect(getLatestSnapshotByProject(ctx.db, projectId)?.recoveryStatus).toBe('unrecoverable')
  })

  it('canonicalizes a non-canonical needs_input output instead of failing the run', async () => {
    const projectId = await register(ctx.db)
    const run = getRunById(ctx.db, listRunsByProject(ctx.db, projectId)[0]?.id ?? '')
    if (run === null) {
      throw new Error('run missing')
    }
    // モデルが needs_input に説明文や item を付けてきても、run を failed にせず
    // 固定形式へ正規化して unrecoverable の snapshot を残す。
    useFakeCodex({
      output: {
        schemaVersion: 1,
        currentPosition: {
          status: 'needs_input',
          text: '現在位置の根拠がありません',
          evidenceIds: [],
        },
        completedItems: {
          status: 'needs_input',
          items: [{ text: '不明', evidenceIds: [] }],
          evidenceIds: [],
        },
        nextActions: needsInputList,
        importantDecisions: needsInputList,
      },
    })

    await runGeneration(ctx.db, run)

    expect(getRunById(ctx.db, run.id)?.status).toBe('unrecoverable')
    const snapshot = getLatestSnapshotByProject(ctx.db, projectId)
    expect(snapshot?.recoveryStatus).toBe('unrecoverable')
    expect(snapshot?.currentPosition).toEqual({
      status: 'needs_input',
      text: '要補完',
      evidenceIds: [],
    })
    expect(snapshot?.completedItems).toEqual({ status: 'needs_input', items: [], evidenceIds: [] })
  })

  it('POST /api/projects/:id/recover queues a run and 404s for an unknown project', async () => {
    const projectId = await register(ctx.db)
    // 起点の registration recovery を終端させ、active でなくする
    const seed = getRunById(ctx.db, listRunsByProject(ctx.db, projectId)[0]?.id ?? '')
    if (seed !== null) {
      ctx.db.prepare("UPDATE generation_runs SET status = 'failed' WHERE id = ?").run(seed.id)
    }

    const app = await buildApp({ config: loadConfig({ TRACKER_DATA_DIR: '' }), db: ctx.db })
    try {
      const ok = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/recover` })
      expect(ok.statusCode).toBe(202)
      expect(ok.json()).toMatchObject({ status: 'queued' })

      const missing = await app.inject({ method: 'POST', url: '/api/projects/nope/recover' })
      expect(missing.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('ships a well-formed recovery fixture: 10 recoverable + 4 evidence-insufficient', () => {
    const fixturePath = join(process.cwd(), 'tests/fixtures/recovery-cases.json')
    const { cases } = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      cases: Array<{
        id: string
        expectedRecoveryStatus: string
        evidence: Array<{ externalKey: string }>
        expected: Record<
          string,
          { status: string; mustContain: string[]; requiredEvidenceExternalKeys: string[] }
        >
      }>
    }

    expect(cases).toHaveLength(14)
    expect(cases.filter((c) => c.expectedRecoveryStatus === 'unrecoverable')).toHaveLength(4)
    expect(cases.filter((c) => c.expectedRecoveryStatus === 'complete')).toHaveLength(10)
    expect(new Set(cases.map((c) => c.id)).size).toBe(14)

    const fieldKeys = ['currentPosition', 'completedItems', 'nextActions', 'importantDecisions']
    for (const testCase of cases) {
      const evidenceKeys = new Set(testCase.evidence.map((e) => e.externalKey))
      expect(Object.keys(testCase.expected).sort()).toEqual([...fieldKeys].sort())
      for (const field of fieldKeys) {
        const expectation = testCase.expected[field]
        expect(['confirmed', 'needs_input']).toContain(expectation?.status)
        // 参照必須の evidence key は必ずそのケースの evidence に存在する
        for (const key of expectation?.requiredEvidenceExternalKeys ?? []) {
          expect(evidenceKeys.has(key)).toBe(true)
        }
        if (testCase.expectedRecoveryStatus === 'unrecoverable') {
          expect(expectation?.status).toBe('needs_input')
        }
      }
    }
  })
})
