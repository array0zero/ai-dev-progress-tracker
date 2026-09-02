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

function seedManyProjects(count: number, snapshotsEach: number): void {
  const db = openDatabase(DB_PATH)
  try {
    const needsInput = { status: 'needs_input', items: [], evidenceIds: [] }
    const seed = db.transaction(() => {
      for (let p = 0; p < count; p += 1) {
        const projectId = randomUUID()
        const sha = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8)
        insertProject(db, {
          id: projectId,
          name: `Perf ${String(p).padStart(3, '0')}`,
          localPath: `/perf/${projectId}`,
          repoNodeId: `NODE_${projectId}`,
          repoOwner: 'perf',
          repoName: 'demo',
          repoUrl: 'https://github.com/perf/demo',
          defaultBranch: 'main',
          status: 'active',
        })
        upsertCommit(db, {
          projectId,
          sha,
          parentSha: null,
          message: 'perf seed',
          authoredAt: '2026-09-01T00:00:00.000Z',
          detectedAt: '2026-09-01T00:00:01.000Z',
        })
        for (let s = 0; s < snapshotsEach; s += 1) {
          const runId = randomUUID()
          const ts = `2026-09-01T00:${String(s).padStart(2, '0')}:00.000Z`
          db.prepare(
            `INSERT INTO generation_runs (id, dedupe_key, project_id, commit_sha, mode, trigger, status, detected_at)
             VALUES (?, ?, ?, ?, 'generation', 'post_commit', 'partial', ?)`,
          ).run(runId, `generation:${projectId}:${sha}:${s}`, projectId, sha, ts)
          markRunTerminal(db, runId, 'partial')
          insertSnapshot(db, {
            id: randomUUID(),
            generationRunId: runId,
            projectId,
            commitSha: sha,
            recoveryStatus: 'partial',
            currentPosition: { status: 'needs_input', text: '要補完', evidenceIds: [] },
            completedItems: needsInput,
            nextActions: needsInput,
            decisions: needsInput,
          })
        }
      }
    })
    seed()
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

test('shows the app shell and the collapsed manual registration form', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'AI Dev Progress Tracker' })).toBeVisible()
  await expect(page.getByRole('region', { name: '表示条件' })).toBeVisible()
  // 通常状態では手動登録は畳まれている (dense list の 1 画面要件のため)
  await expect(page.getByLabel('プロジェクト名')).toBeHidden()
  await page.getByText('手動で登録').click()
  await expect(page.getByLabel('プロジェクト名')).toBeVisible()
})

test('renders name, current position, next action and last update on each dense row', async ({
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
    // 詳細へ遷移しなくても 名前 / 現在地 / 次の作業 / 最終更新 が行内にある
    await expect(cardA.locator('.dense-row__name')).toHaveText('Dash A')
    await expect(cardA.locator('.dense-row__current')).not.toBeEmpty()
    await expect(cardA.locator('.dense-row__next')).toHaveCount(1)
    await expect(cardA.locator('.dense-row__updated')).not.toBeEmpty()

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
  await expect(complete.locator('.dense-row__current')).toHaveText('CURRENT_POSITION_TEXT')

  const partial = page.getByRole('article', { name: 'T11 Partial' })
  await expect(partial.locator('.dense-row__current')).toHaveText('要補完')

  // snapshot のない project は固定 fallback を出す
  const failed = page.getByRole('article', { name: 'T11 Failed' })
  await expect(failed.locator('.dense-row__current')).toHaveText('進捗生成待ち')
})

test('rejects a non-localhost Host header with 403', async ({ request }) => {
  const response = await request.get('/api/health', { headers: { host: 'evil.example.com' } })
  expect(response.status()).toBe(403)
  const ok = await request.get('/api/health')
  expect(ok.status()).toBe(200)
})

test('rejects a mutation from an external Origin with 403', async ({ request }) => {
  const blocked = await request.post('/api/backup', {
    headers: { origin: 'http://evil.example.com' },
    data: {},
  })
  expect(blocked.status()).toBe(403)

  // Origin なしの POST は許可される
  const allowed = await request.post('/api/backup', { data: {} })
  expect([202, 409]).toContain(allowed.status())
})

test('surfaces the latest generation failure in a dashboard banner', async ({ page }) => {
  seedProjectWithProgress({
    name: 'Sys Failed',
    recoveryStatus: 'complete',
    runStatus: 'failed',
    withSnapshot: false,
  })

  await page.goto('/')
  const banner = page.locator('.status-banner--warning', { hasText: '最新の生成失敗' })
  await expect(banner).toBeVisible()
})

test('renders 100 projects with 20 snapshots each within 2 seconds', async ({ page, request }) => {
  seedManyProjects(100, 20)

  const apiStart = Date.now()
  const apiResponse = await request.get('/api/projects')
  expect(apiResponse.status()).toBe(200)
  const apiMs = Date.now() - apiStart

  const renderStart = Date.now()
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('article[aria-label^="Perf "]')).toHaveCount(100)
  const totalMs = Date.now() - renderStart

  expect(apiMs).toBeLessThan(2000)
  expect(totalMs).toBeLessThan(2000)
})

interface DenseSeed {
  name: string
  lastUpdatedAt: string
  withSnapshot?: boolean
  nextActions?: string[]
  reviewRequired?: boolean
  localPath?: string
  commitSha?: string
}

/** dense list 用に 8 件を直接 seed する (freshness は API 側で計算される)。 */
function seedDenseProjects(seeds: readonly DenseSeed[]): void {
  const db = openDatabase(DB_PATH)
  try {
    const run = db.transaction(() => {
      for (const seed of seeds) {
        const projectId = randomUUID()
        const sha =
          seed.commitSha ??
          randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8)
        insertProject(
          db,
          {
            id: projectId,
            name: seed.name,
            localPath: seed.localPath ?? `/dense/${projectId}`,
            repoNodeId: `NODE_${projectId}`,
            repoOwner: 'dense',
            repoName: 'demo',
            repoUrl: 'https://github.com/dense/demo',
            defaultBranch: 'main',
            status: 'active',
            summary: `${seed.name} の概要`,
            reviewRequired: seed.reviewRequired === true,
          },
          new Date(seed.lastUpdatedAt),
        )
        upsertCommit(db, {
          projectId,
          sha,
          parentSha: null,
          message: 'dense seed',
          authoredAt: seed.lastUpdatedAt,
          detectedAt: seed.lastUpdatedAt,
        })
        if (seed.withSnapshot === false) {
          continue
        }
        const runId = randomUUID()
        db.prepare(
          `INSERT INTO generation_runs (id, dedupe_key, project_id, commit_sha, mode, trigger, status, detected_at)
           VALUES (?, ?, ?, ?, 'generation', 'post_commit', 'queued', ?)`,
        ).run(runId, `generation:${projectId}:${sha}`, projectId, sha, seed.lastUpdatedAt)
        markRunTerminal(db, runId, 'succeeded')
        const nextActions =
          seed.nextActions === undefined || seed.nextActions.length === 0
            ? { status: 'needs_input', items: [], evidenceIds: [] }
            : {
                status: 'confirmed',
                items: seed.nextActions.map((text) => ({ text, evidenceIds: [] })),
                evidenceIds: [],
              }
        insertSnapshot(
          db,
          {
            id: randomUUID(),
            generationRunId: runId,
            projectId,
            commitSha: sha,
            recoveryStatus: 'complete',
            currentPosition: {
              status: 'confirmed',
              text: `${seed.name} の現在地`,
              evidenceIds: [],
            },
            completedItems: { status: 'needs_input', items: [], evidenceIds: [] },
            nextActions,
            decisions: { status: 'needs_input', items: [], evidenceIds: [] },
          },
          new Date(seed.lastUpdatedAt),
        )
      }
    })
    run()
  } finally {
    db.close()
  }
}

function clearProjects(): void {
  const db = openDatabase(DB_PATH)
  try {
    db.exec('DELETE FROM registration_candidates; DELETE FROM projects;')
  } finally {
    db.close()
  }
}

test('fits eight dense rows into the 2005x1271 acceptance viewport without scrolling', async ({
  page,
}) => {
  clearProjects()
  seedDenseProjects(
    Array.from({ length: 8 }, (_, index) => ({
      name: `Dense ${String(index).padStart(2, '0')}`,
      lastUpdatedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      nextActions: [`次の作業 ${index}`],
    })),
  )

  await page.setViewportSize({ width: 2005, height: 1271 })
  await page.goto('/')
  const rows = page.locator('.dense-row')
  await expect(rows).toHaveCount(8)

  const overflow = await page.evaluate(() => {
    const element = document.scrollingElement as HTMLElement
    return element.scrollHeight - element.clientHeight
  })
  expect(overflow).toBeLessThanOrEqual(0)

  // 8 行すべてが viewport 内に収まっている
  for (let index = 0; index < 8; index += 1) {
    const box = await rows.nth(index).boundingBox()
    expect(box).not.toBeNull()
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(1271)
  }

  // default sort は lastUpdatedAt DESC
  const names = await page.locator('.dense-row__name').allTextContents()
  expect(names[0]).toBe('Dense 07')
  expect(names[7]).toBe('Dense 00')
})

test('filters by each state and by several states at once', async ({ page }) => {
  clearProjects()
  seedDenseProjects([
    { name: 'F Next', lastUpdatedAt: '2026-09-01T00:00:00.000Z', nextActions: ['続きを実装'] },
    { name: 'F Review', lastUpdatedAt: '2026-09-02T00:00:00.000Z', reviewRequired: true },
    { name: 'F Unreflected', lastUpdatedAt: '2026-09-03T00:00:00.000Z', withSnapshot: false },
    { name: 'F Plain', lastUpdatedAt: '2026-09-04T00:00:00.000Z' },
  ])

  await page.goto('/')
  await expect(page.locator('.dense-row')).toHaveCount(4)

  await page.getByLabel('次の作業あり').check()
  await expect(page.locator('.dense-row__name')).toHaveText(['F Next'])

  await page.getByLabel('要確認').check()
  await expect(page.locator('.dense-row__name')).toHaveText(['F Review', 'F Next'])

  await page.getByLabel('次の作業あり').uncheck()
  await expect(page.locator('.dense-row__name')).toHaveText(['F Review'])

  await page.getByLabel('要確認').uncheck()
  await page.getByLabel('未反映').check()
  await expect(page.locator('.dense-row__name')).toHaveText(['F Unreflected'])
})

test('shows an empty state for zero projects and for a filter with no matches', async ({
  page,
}) => {
  clearProjects()
  await page.goto('/')
  await expect(page.getByText('登録済みプロジェクトはありません。')).toBeVisible()

  seedDenseProjects([{ name: 'Only One', lastUpdatedAt: '2026-09-01T00:00:00.000Z' }])
  await page.reload()
  await page.getByLabel('次の作業あり').check()
  await expect(page.getByText('条件に一致するプロジェクトはありません。')).toBeVisible()
  await expect(page.locator('.dense-row')).toHaveCount(0)
})

test('shows the unreflected badge that matches the real Git HEAD from the API', async ({
  page,
  request,
}) => {
  clearProjects()
  const repo = seedRepo('e2e/fresh')
  try {
    const created = await request.post('/api/projects', {
      data: { name: 'Fresh Row', localPath: repo.root, repository: 'e2e/fresh' },
    })
    expect(created.status()).toBe(201)

    await page.goto('/')
    const row = page.getByRole('article', { name: 'Fresh Row' })
    await expect(row.getByText('未反映')).toBeVisible()

    const api = await request.get('/api/projects')
    const projects = (await api.json()) as Array<{
      name: string
      latestCommitSha: string | null
      unreflected: boolean
    }>
    const summary = projects.find((project) => project.name === 'Fresh Row')
    expect(summary?.unreflected).toBe(true)
    expect(summary?.latestCommitSha).toBe(repo.git('rev-parse', 'HEAD'))
  } finally {
    repo.cleanup()
  }
})
