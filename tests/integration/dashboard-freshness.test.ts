import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
import { insertSnapshot } from '../../src/server/db/progress-repository.js'
import { insertProject, setProjectReviewRequired } from '../../src/server/db/project-repository.js'
import { insertRun, upsertCommit } from '../../src/server/db/run-repository.js'
import type { ProjectSummaryV2 } from '../../src/shared/api.js'
import { createTempDir, createTempRepo, type TempRepo } from '../helpers/temp-repo.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

function confirmedText(text: string): unknown {
  return { status: 'confirmed', text, evidenceIds: [] }
}

function confirmedItems(texts: string[]): unknown {
  return {
    status: 'confirmed',
    items: texts.map((text) => ({ text, evidenceIds: [] })),
    evidenceIds: [],
  }
}

const NEEDS_INPUT_LIST: unknown = { status: 'needs_input', items: [], evidenceIds: [] }

describe('dashboard freshness projection', () => {
  let ctx: TestDb
  let repo: TempRepo

  function registerProjectRow(localPath: string, name = 'demo'): string {
    const id = randomUUID()
    insertProject(ctx.db, {
      id,
      name,
      localPath,
      repoNodeId: `NODE_${id}`,
      repoOwner: 'octo',
      repoName: name,
      repoUrl: `https://github.com/octo/${name}`,
      defaultBranch: 'main',
      status: 'active',
      summary: `${name} summary`,
    })
    return id
  }

  function seedSnapshot(projectId: string, commitSha: string, nextActions: unknown): void {
    const runId = randomUUID()
    upsertCommit(ctx.db, {
      projectId,
      sha: commitSha,
      parentSha: null,
      message: 'seed',
      authoredAt: '2026-09-02T00:00:00.000Z',
      detectedAt: '2026-09-02T00:00:00.000Z',
    })
    insertRun(ctx.db, {
      id: runId,
      dedupeKey: `generation:${projectId}:${runId}`,
      projectId,
      commitSha,
      mode: 'generation',
      trigger: 'post_commit',
      detectedAt: '2026-09-02T00:00:00.000Z',
    })
    insertSnapshot(
      ctx.db,
      {
        id: randomUUID(),
        generationRunId: runId,
        projectId,
        commitSha,
        recoveryStatus: 'complete',
        currentPosition: confirmedText('基盤実装'),
        completedItems: confirmedItems(['DB作成']),
        nextActions,
        decisions: NEEDS_INPUT_LIST,
      },
      new Date('2026-09-02T01:00:00.000Z'),
    )
  }

  async function getSummaries(): Promise<ProjectSummaryV2[]> {
    const app = await buildApp({ config: loadConfig({ TRACKER_DATA_DIR: '' }), db: ctx.db })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/projects' })
      expect(response.statusCode).toBe(200)
      return response.json() as ProjectSummaryV2[]
    } finally {
      await app.close()
    }
  }

  beforeEach(() => {
    ctx = createTestDb()
    repo = createTempRepo()
  })

  afterEach(() => {
    repo.cleanup()
    ctx.cleanup()
  })

  it('returns an empty list for zero projects', async () => {
    expect(await getSummaries()).toEqual([])
  })

  it('marks a project with a HEAD and no snapshot as unreflected and waiting for generation', async () => {
    registerProjectRow(realpathSync.native(repo.root))
    const head = repo.git('rev-parse', 'HEAD')

    const [summary] = await getSummaries()
    expect(summary).toMatchObject({
      latestCommitSha: head,
      lastGeneratedCommitSha: null,
      lastGeneratedAt: null,
      unreflected: true,
      hasNextAction: false,
      currentPosition: '進捗生成待ち',
    })
    expect(summary?.nextActions).toEqual([])
    // 未登録 commit の metadata は DB へ入り、再 GET でも同じ値が返る
    expect((await getSummaries())[0]?.latestCommitSha).toBe(head)
    expect(ctx.db.prepare('SELECT COUNT(*) FROM commits WHERE sha = ?').pluck().get(head)).toBe(1)
  })

  it('waits for the first commit when the repository has no HEAD', async () => {
    const folder = createTempDir('adpt-fresh-')
    try {
      execFileSync('git', ['init', '-b', 'main', folder.root])
      registerProjectRow(realpathSync.native(folder.root), 'empty')

      const [summary] = await getSummaries()
      expect(summary).toMatchObject({
        latestCommitSha: null,
        unreflected: false,
        currentPosition: '初回コミット待ち',
      })
      expect(summary?.nextActions).toEqual([])
    } finally {
      folder.cleanup()
    }
  })

  it('clears unreflected when the snapshot commit matches the real HEAD', async () => {
    const projectId = registerProjectRow(realpathSync.native(repo.root))
    const head = repo.git('rev-parse', 'HEAD')
    seedSnapshot(projectId, head, confirmedItems(['Codex連携']))

    const [summary] = await getSummaries()
    expect(summary).toMatchObject({
      latestCommitSha: head,
      lastGeneratedCommitSha: head,
      lastGeneratedAt: '2026-09-02T01:00:00.000Z',
      unreflected: false,
      hasNextAction: true,
    })
  })

  it('reports unreflected again after a new commit lands in the real repository', async () => {
    const projectId = registerProjectRow(realpathSync.native(repo.root))
    const firstHead = repo.git('rev-parse', 'HEAD')
    seedSnapshot(projectId, firstHead, NEEDS_INPUT_LIST)

    writeFileSync(join(repo.root, 'next.txt'), 'more work\n')
    repo.git('add', '.')
    repo.git('commit', '-m', 'second commit')
    const secondHead = repo.git('rev-parse', 'HEAD')
    expect(secondHead).not.toBe(firstHead)

    const [summary] = await getSummaries()
    expect(summary).toMatchObject({
      latestCommitSha: secondHead,
      lastGeneratedCommitSha: firstHead,
      unreflected: true,
      hasNextAction: false,
    })
  })

  it('includes review time but not backup time in lastUpdatedAt', async () => {
    const projectId = registerProjectRow(realpathSync.native(repo.root))
    ctx.db
      .prepare(
        "INSERT INTO backup_runs (id, trigger, project_id, source_commit_sha, backup_repo, status, queued_at) VALUES (?, 'manual', ?, NULL, 'octo/backup', 'succeeded', '2099-01-01T00:00:00.000Z')",
      )
      .run(randomUUID(), projectId)

    const before = (await getSummaries())[0]?.lastUpdatedAt ?? ''
    expect(before < '2099-01-01T00:00:00.000Z').toBe(true)

    setProjectReviewRequired(ctx.db, projectId, true, new Date('2030-01-01T00:00:00.000Z'))
    const after = (await getSummaries())[0]
    expect(after?.lastUpdatedAt).toBe('2030-01-01T00:00:00.000Z')
    expect(after?.reviewRequired).toBe(true)
  })

  it('flags a project whose local path disappeared as local_missing but keeps the row', async () => {
    const folder = createTempDir('adpt-gone-')
    const gonePath = realpathSync.native(folder.root)
    registerProjectRow(gonePath, 'gone')
    folder.cleanup()

    const summaries = await getSummaries()
    expect(summaries).toHaveLength(1)
    expect(
      ctx.db.prepare('SELECT status FROM projects WHERE local_path = ?').pluck().get(gonePath),
    ).toBe('local_missing')
  })
})
