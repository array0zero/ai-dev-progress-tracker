import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openDatabase } from '../../src/server/db/connection.js'
import { insertSnapshot } from '../../src/server/db/progress-repository.js'
import { insertProject } from '../../src/server/db/project-repository.js'
import { markRunTerminal, upsertCommit } from '../../src/server/db/run-repository.js'
import { addRepoFixture } from '../helpers/fake-gh.js'
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js'

const FIXTURES_PATH = process.env.E2E_GH_FIXTURES ?? ''
const DB_PATH = join(process.env.E2E_TRACKER_DATA_DIR ?? '', 'tracker.db')

interface SeedProgressOptions {
  name: string
  recoveryStatus: 'complete' | 'partial' | 'unrecoverable'
  currentPositionNeedsInput?: boolean
  runStatus?: 'succeeded' | 'partial' | 'unrecoverable' | 'failed'
  withSnapshot?: boolean
}

function seedProjectWithProgress(options: SeedProgressOptions): void {
  const db = openDatabase(DB_PATH)
  try {
    const projectId = randomUUID()
    const sha = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8)
    insertProject(db, {
      id: projectId,
      name: options.name,
      localPath: `/seed/${projectId}`,
      repoNodeId: `NODE_${projectId}`,
      repoOwner: 'seed',
      repoName: 'demo',
      repoUrl: 'https://github.com/seed/demo',
      defaultBranch: 'main',
      status: 'active',
    })
    upsertCommit(db, {
      projectId,
      sha,
      parentSha: null,
      message: 'seed',
      authoredAt: '2026-09-01T00:00:00.000Z',
      detectedAt: '2026-09-01T00:00:01.000Z',
    })
    const runId = randomUUID()
    db.prepare(
      `INSERT INTO generation_runs (id, dedupe_key, project_id, commit_sha, mode, trigger, status, detected_at)
       VALUES (?, ?, ?, ?, 'generation', 'post_commit', 'queued', ?)`,
    ).run(runId, `generation:${projectId}:${sha}`, projectId, sha, '2026-09-01T00:00:02.000Z')
    markRunTerminal(db, runId, options.runStatus ?? 'succeeded')

    if (options.withSnapshot !== false) {
      const evId = randomUUID()
      db.prepare(
        `INSERT INTO evidence (id, project_id, kind, external_key, source_version, title, url, payload_json, captured_at)
         VALUES (?, ?, 'commit', ?, ?, 'seed commit', null, '{}', ?)`,
      ).run(evId, projectId, sha.slice(0, 7), sha, '2026-09-01T00:00:03.000Z')
      const confirmedText = {
        status: 'confirmed',
        text: 'CURRENT_POSITION_TEXT',
        evidenceIds: [evId],
      }
      const needsInput = { status: 'needs_input', text: '要補完', evidenceIds: [] }
      const confirmedList = {
        status: 'confirmed',
        items: [{ text: 'DONE_ITEM', evidenceIds: [evId] }],
        evidenceIds: [evId],
      }
      insertSnapshot(db, {
        id: randomUUID(),
        generationRunId: runId,
        projectId,
        commitSha: sha,
        recoveryStatus: options.recoveryStatus,
        currentPosition: options.currentPositionNeedsInput ? needsInput : confirmedText,
        completedItems: confirmedList,
        nextActions: { status: 'needs_input', items: [], evidenceIds: [] },
        decisions: { status: 'needs_input', items: [], evidenceIds: [] },
      })
    }
  } finally {
    db.close()
  }
}

function seedRepo(slug: string): TempRepo {
  const repo = createTempRepo({ origin: `https://github.com/${slug}.git` })
  addRepoFixture(FIXTURES_PATH, slug, {
    id: `NODE_${slug.replace('/', '_')}`,
    nameWithOwner: slug,
    url: `https://github.com/${slug}`,
    visibility: 'PRIVATE',
    defaultBranchRef: { name: 'main' },
  })
  return repo
}

test('shows the app shell and the registration form', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'AI Dev Progress Tracker' })).toBeVisible()
  await expect(page.getByLabel('プロジェクト名')).toBeVisible()
})

test('renders repository, short SHA and the three progress rows per project card', async ({
  page,
  request,
}) => {
  const repoA = seedRepo('e2e/dash-a')
  const repoB = seedRepo('e2e/dash-b')
  try {
    for (const [name, root, slug] of [
      ['Dash A', repoA.root, 'e2e/dash-a'],
      ['Dash B', repoB.root, 'e2e/dash-b'],
    ] as const) {
      const response = await request.post('/api/projects', {
        data: { name, localPath: root, repository: slug },
      })
      expect(response.status()).toBe(201)
    }

    await page.goto('/')
    const cardA = page.getByRole('article', { name: 'Dash A' })
    const cardB = page.getByRole('article', { name: 'Dash B' })

    await expect(cardA).toBeVisible()
    await expect(cardB).toBeVisible()

    await expect(cardA).toContainText('e2e/dash-a')
    await expect(cardA.locator('.project-card__sha')).toHaveText(/^[0-9a-f]{8}$/)
    for (const label of ['現在地', '完了事項', '次の作業']) {
      await expect(cardA.getByText(label, { exact: true })).toBeVisible()
    }

    // 別 project の情報が混ざらない
    await expect(cardA).not.toContainText('e2e/dash-b')
    await expect(cardB).not.toContainText('e2e/dash-a')
  } finally {
    repoA.cleanup()
    repoB.cleanup()
  }
})

test('reflects a completed snapshot, a partial one, and a failed generation on the cards', async ({
  page,
}) => {
  seedProjectWithProgress({ name: 'T11 Complete', recoveryStatus: 'complete' })
  seedProjectWithProgress({
    name: 'T11 Partial',
    recoveryStatus: 'partial',
    runStatus: 'partial',
    currentPositionNeedsInput: true,
  })
  seedProjectWithProgress({
    name: 'T11 Failed',
    recoveryStatus: 'complete',
    runStatus: 'failed',
    withSnapshot: false,
  })

  await page.goto('/')

  const complete = page.getByRole('article', { name: 'T11 Complete' })
  await expect(complete).toContainText('CURRENT_POSITION_TEXT')
  await expect(complete).toContainText('DONE_ITEM')
  await expect(complete).toContainText('generation: succeeded')

  const partial = page.getByRole('article', { name: 'T11 Partial' })
  await expect(partial).toContainText('generation: partial')
  await expect(partial.locator('.project-card__progress dd').first()).toHaveText('要補完')

  const failed = page.getByRole('article', { name: 'T11 Failed' })
  await expect(failed).toContainText('generation: failed')
  await expect(failed).toContainText('進捗生成中')
})
