import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openDatabase } from '../../src/server/db/connection.js'
import { insertSnapshot } from '../../src/server/db/progress-repository.js'
import { insertProject } from '../../src/server/db/project-repository.js'
import { upsertCommit } from '../../src/server/db/run-repository.js'

const DB_PATH = join(process.env.E2E_TRACKER_DATA_DIR ?? '', 'tracker.db')
const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

interface SeededEvidence {
  id: string
  projectId: string
  title: string
  url: string | null
}

function seedProject(name: string): string {
  const db = openDatabase(DB_PATH)
  try {
    const projectId = randomUUID()
    insertProject(db, {
      id: projectId,
      name,
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
      sha: SHA,
      parentSha: null,
      message: 'seed commit',
      authoredAt: '2026-09-01T00:00:00.000Z',
      detectedAt: '2026-09-01T00:00:01.000Z',
    })
    return projectId
  } finally {
    db.close()
  }
}

function seedEvidence(projectId: string, title: string, url: string | null): SeededEvidence {
  const db = openDatabase(DB_PATH)
  try {
    const id = randomUUID()
    db.prepare(
      `INSERT INTO evidence (id, project_id, kind, external_key, source_version, title, url, payload_json, captured_at)
       VALUES (?, ?, 'commit', ?, ?, ?, ?, '{}', ?)`,
    ).run(id, projectId, SHA.slice(0, 7), SHA, title, url, '2026-09-01T00:00:02.000Z')
    return { id, projectId, title, url }
  } finally {
    db.close()
  }
}

function seedManyEvidence(projectId: string, count: number): string[] {
  const db = openDatabase(DB_PATH)
  try {
    const ids: string[] = []
    const insert = db.prepare(
      `INSERT INTO evidence (id, project_id, kind, external_key, source_version, title, url, payload_json, captured_at)
       VALUES (?, ?, 'commit', ?, ?, ?, ?, '{}', ?)`,
    )
    const seed = db.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        const id = randomUUID()
        ids.push(id)
        insert.run(
          id,
          projectId,
          `key-${i}`,
          `${SHA}-${i}`,
          `evidence subject ${i}`,
          `https://github.com/seed/demo/commit/${i}`,
          '2026-09-01T00:00:02.000Z',
        )
      }
    })
    seed()
    return ids
  } finally {
    db.close()
  }
}

function seedSnapshot(projectId: string, decisionEvidenceIds: string[]): void {
  const db = openDatabase(DB_PATH)
  try {
    const runId = randomUUID()
    db.prepare(
      `INSERT INTO generation_runs (id, dedupe_key, project_id, commit_sha, mode, trigger, status, detected_at)
       VALUES (?, ?, ?, ?, 'generation', 'post_commit', 'partial', ?)`,
    ).run(runId, `generation:${projectId}:${SHA}`, projectId, SHA, '2026-09-01T00:00:03.000Z')

    const needsInput = { status: 'needs_input', items: [], evidenceIds: [] }
    insertSnapshot(db, {
      id: randomUUID(),
      generationRunId: runId,
      projectId,
      commitSha: SHA,
      recoveryStatus: 'partial',
      currentPosition: { status: 'needs_input', text: '要補完', evidenceIds: [] },
      completedItems: needsInput,
      nextActions: needsInput,
      decisions: {
        status: 'confirmed',
        items: [
          {
            decision: 'Use SQLite for the local store',
            rationale: 'Single-user local MVP, no server database needed',
            evidenceIds: decisionEvidenceIds,
          },
        ],
        evidenceIds: decisionEvidenceIds,
      },
    })
  } finally {
    db.close()
  }
}

test('routes /projects/:id to the detail page and shows PROJECT_NOT_FOUND for an unknown id', async ({
  page,
}) => {
  await page.goto('/projects/does-not-exist')
  await expect(page.getByRole('link', { name: '← 一覧へ' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('PROJECT_NOT_FOUND')
})

test('shows the decision, rationale and its evidence with an external link', async ({ page }) => {
  const projectId = seedProject('Detail With Evidence')
  const evidence = seedEvidence(
    projectId,
    'seed commit subject',
    'https://github.com/seed/demo/commit/abcdef0',
  )
  seedSnapshot(projectId, [evidence.id])

  await page.goto(`/projects/${projectId}`)
  const card = page.getByRole('article', { name: 'Detail With Evidence' })
  await expect(card).toContainText('Use SQLite for the local store')
  await expect(card).toContainText('Single-user local MVP')
  await expect(card).toContainText('seed commit subject')
  await expect(card.getByText('commit', { exact: true })).toBeVisible()
  await expect(card.getByRole('link', { name: 'GitHub で開く' })).toBeVisible()
})

test('omits the external link when the evidence has no url', async ({ page }) => {
  const projectId = seedProject('Detail No Url')
  const evidence = seedEvidence(projectId, 'commit without url', null)
  seedSnapshot(projectId, [evidence.id])

  await page.goto(`/projects/${projectId}`)
  const card = page.getByRole('article', { name: 'Detail No Url' })
  await expect(card).toContainText('commit without url')
  await expect(card.getByRole('link', { name: 'GitHub で開く' })).toHaveCount(0)
})

test('reports SNAPSHOT_INCONSISTENT and does not resolve evidence from another project', async ({
  page,
}) => {
  const projectA = seedProject('Detail A')
  const projectB = seedProject('Detail B')
  const evidenceB = seedEvidence(
    projectB,
    'EVIDENCE_B_TITLE',
    'https://github.com/seed/demo/commit/b',
  )
  // project A の snapshot が project B の evidence を参照する
  seedSnapshot(projectA, [evidenceB.id])

  await page.goto(`/projects/${projectA}`)
  await expect(page.getByRole('alert')).toContainText('SNAPSHOT_INCONSISTENT')
  await expect(page.locator('body')).not.toContainText('EVIDENCE_B_TITLE')
})

test('renders a project with 100 evidence items within 2 seconds', async ({ page, request }) => {
  const projectId = seedProject('Detail Perf')
  const evidenceIds = seedManyEvidence(projectId, 100)
  seedSnapshot(projectId, evidenceIds)

  const apiStart = Date.now()
  const apiResponse = await request.get(`/api/projects/${projectId}`)
  expect(apiResponse.status()).toBe(200)
  const apiMs = Date.now() - apiStart

  const renderStart = Date.now()
  await page.goto(`/projects/${projectId}`, { waitUntil: 'load' })
  const card = page.getByRole('article', { name: 'Detail Perf' })
  await expect(card).toContainText('evidence subject 0')
  await expect(card).toContainText('evidence subject 99')
  const totalMs = Date.now() - renderStart

  expect(apiMs).toBeLessThan(2000)
  expect(totalMs).toBeLessThan(2000)
})

test('toggles the review flag from the detail page and reflects it on the dashboard', async ({
  page,
  request,
}) => {
  const projectId = seedProject('Review Toggle')

  await page.goto(`/projects/${projectId}`)
  const controls = page.getByRole('region', { name: '要確認と再生成' })
  const flag = controls.getByLabel('要確認')
  await expect(flag).not.toBeChecked()

  await flag.check()
  await expect(flag).toBeChecked()

  // HTTP 側の読み直しと dashboard 表示が一致する
  const detail = await request.get(`/api/projects/${projectId}`)
  const body = (await detail.json()) as { reviewRequired: boolean; reviewRequiredAt: string | null }
  expect(body.reviewRequired).toBe(true)
  expect(body.reviewRequiredAt).not.toBeNull()

  await page.goto('/')
  await expect(
    page.getByRole('article', { name: 'Review Toggle' }).getByText('要確認'),
  ).toBeVisible()

  // 利用者が false にしたときだけ解除される
  await page.goto(`/projects/${projectId}`)
  await page.getByRole('region', { name: '要確認と再生成' }).getByLabel('要確認').uncheck()
  const cleared = await request.get(`/api/projects/${projectId}`)
  expect((await cleared.json()) as { reviewRequired: boolean }).toMatchObject({
    reviewRequired: false,
  })
})

test('does not start a regeneration for a project without a HEAD commit', async ({ page }) => {
  const db = openDatabase(DB_PATH)
  let projectId = ''
  try {
    projectId = randomUUID()
    insertProject(db, {
      id: projectId,
      name: 'No Head',
      localPath: `/seed/${projectId}`,
      repoNodeId: `NODE_${projectId}`,
      repoOwner: 'seed',
      repoName: 'demo',
      repoUrl: 'https://github.com/seed/demo',
      defaultBranch: 'main',
      status: 'active',
    })
  } finally {
    db.close()
  }

  await page.goto(`/projects/${projectId}`)
  await page.getByRole('button', { name: '進捗を再生成' }).click()
  await expect(page.getByRole('alert')).toContainText('INVALID_REQUEST')

  // 要確認は HEAD が無くても設定できる
  await page.getByRole('region', { name: '要確認と再生成' }).getByLabel('要確認').check()
  await expect(
    page.getByRole('region', { name: '要確認と再生成' }).getByLabel('要確認'),
  ).toBeChecked()
})

function seedHistory(projectId: string, count: number): string[] {
  const db = openDatabase(DB_PATH)
  const shas: string[] = []
  try {
    const seed = db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const sha = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8)
        shas.push(sha)
        upsertCommit(db, {
          projectId,
          sha,
          parentSha: null,
          message: `history ${index}`,
          authoredAt: '2026-09-01T00:00:00.000Z',
          detectedAt: `2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`,
        })
        const runId = randomUUID()
        db.prepare(
          `INSERT INTO generation_runs (id, dedupe_key, project_id, commit_sha, mode, trigger, status, detected_at)
           VALUES (?, ?, ?, ?, 'generation', 'post_commit', 'succeeded', ?)`,
        ).run(
          runId,
          `generation:${projectId}:${sha}`,
          projectId,
          sha,
          `2026-09-01T00:${String(index).padStart(2, '0')}:01.000Z`,
        )
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
              text: `履歴 ${index} の現在地`,
              evidenceIds: [],
            },
            completedItems: { status: 'needs_input', items: [], evidenceIds: [] },
            nextActions: { status: 'needs_input', items: [], evidenceIds: [] },
            decisions: { status: 'needs_input', items: [], evidenceIds: [] },
          },
          new Date(`2026-09-01T00:${String(index).padStart(2, '0')}:02.000Z`),
        )
      }
    })
    seed()
  } finally {
    db.close()
  }
  return shas
}

test('keeps the current state above a separate history section', async ({ page }) => {
  const projectId = seedProject('History One')
  seedHistory(projectId, 1)

  await page.goto(`/projects/${projectId}`)

  const current = page.getByRole('article', { name: 'History One' })
  const history = page.getByRole('region', { name: '進捗履歴' })
  await expect(current).toBeVisible()
  await expect(history).toBeVisible()
  await expect(history.getByRole('heading', { name: '進捗履歴' })).toBeVisible()

  // 現在の状態は履歴 section の中にネストされない
  await expect(current.getByRole('region', { name: '進捗履歴' })).toHaveCount(0)
  await expect(history.getByRole('heading', { name: 'History One' })).toHaveCount(0)

  const currentBox = await current.boundingBox()
  const historyBox = await history.boundingBox()
  expect(currentBox?.y ?? 0).toBeLessThan(historyBox?.y ?? 0)
})

test('shows the current section and an empty history when there are no snapshots', async ({
  page,
}) => {
  const projectId = seedProject('History Empty')

  await page.goto(`/projects/${projectId}`)
  await expect(page.getByRole('article', { name: 'History Empty' })).toBeVisible()
  const history = page.getByRole('region', { name: '進捗履歴' })
  await expect(history).toContainText('履歴なし')
})

test('paginates 21 snapshots as 20 plus one more page', async ({ page, request }) => {
  const projectId = seedProject('History Many')
  const shas = seedHistory(projectId, 21)

  await page.goto(`/projects/${projectId}`)
  const history = page.getByRole('region', { name: '進捗履歴' })
  await expect(history.locator('.progress-history__item')).toHaveCount(20)

  await history.getByRole('button', { name: 'さらに読み込む' }).click()
  await expect(history.locator('.progress-history__item')).toHaveCount(21)
  await expect(history.getByRole('button', { name: 'さらに読み込む' })).toHaveCount(0)

  // API から取り直した順序と commit SHA が一致する (newest-first)
  const first = await request.get(`/api/projects/${projectId}/history?limit=20`)
  const firstPage = (await first.json()) as {
    items: Array<{ commitSha: string }>
    nextCursor: string | null
  }
  expect(firstPage.items).toHaveLength(20)
  expect(firstPage.items[0]?.commitSha).toBe(shas[20])
  expect(firstPage.nextCursor).not.toBeNull()

  const second = await request.get(
    `/api/projects/${projectId}/history?limit=20&before=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
  )
  const secondPage = (await second.json()) as {
    items: Array<{ commitSha: string }>
    nextCursor: string | null
  }
  expect(secondPage.items).toHaveLength(1)
  expect(secondPage.items[0]?.commitSha).toBe(shas[0])
  expect(secondPage.nextCursor).toBeNull()
})

test('rejects an out-of-range history limit and an unknown project', async ({ request }) => {
  const projectId = seedProject('History Limits')
  const tooLarge = await request.get(`/api/projects/${projectId}/history?limit=101`)
  expect(tooLarge.status()).toBe(400)
  const unknown = await request.get('/api/projects/does-not-exist/history')
  expect(unknown.status()).toBe(404)
})
