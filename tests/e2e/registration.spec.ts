import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  beginRegistration,
  getCandidate,
  listCandidates,
  recordFailure,
  upsertDetected,
} from '../../src/server/db/candidate-repository.js'
import { openDatabase } from '../../src/server/db/connection.js'
import type { RegistrationCandidate } from '../../src/shared/domain.js'
import { addRepoFixture } from '../helpers/fake-gh.js'
import { createTempDir, createTempRepo, type TempRepo } from '../helpers/temp-repo.js'

const FIXTURES_PATH = process.env.E2E_GH_FIXTURES ?? ''
const DATA_DIR = process.env.E2E_TRACKER_DATA_DIR ?? ''

/** E2E server と同じ data dir へ直接 candidate を作る (agent event は別 process で検証済み)。 */
function withDb<T>(action: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(join(DATA_DIR, 'tracker.db'))
  try {
    return action(db)
  } finally {
    db.close()
  }
}

function seedCandidate(localPath: string, suggestedName: string): RegistrationCandidate {
  return withDb((db) => upsertDetected(db, { localPath, agent: 'codex', suggestedName }))
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

test('shows the API error code in the status banner for an invalid local path', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByLabel('プロジェクト名').fill('Bad Project')
  await page.getByLabel('ローカルGit rootパス').fill('/no/such/path/here')
  await page.getByLabel('GitHub リポジトリ (owner/repo)').fill('acme/widget')
  await page.getByRole('button', { name: '登録' }).click()

  await expect(page.getByRole('alert')).toContainText('NOT_GIT_ROOT')
})

test('registers a project and adds it to the list', async ({ page }) => {
  const repo = seedRepo('e2e/reg')
  try {
    await page.goto('/')
    await page.getByLabel('プロジェクト名').fill('Reg Project')
    await page.getByLabel('ローカルGit rootパス').fill(repo.root)
    await page.getByLabel('GitHub リポジトリ (owner/repo)').fill('e2e/reg')
    await page.getByRole('button', { name: '登録' }).click()

    const card = page.getByRole('article', { name: 'Reg Project' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('e2e/reg')
  } finally {
    repo.cleanup()
  }
})

test('asks for confirmation and registers nothing when the candidate is declined', async ({
  page,
}) => {
  const folder = createTempDir('adpt-e2e-cand-')
  try {
    const candidate = seedCandidate(folder.root, 'candidate-decline')
    await page.goto(`/?candidate=${candidate.id}`)

    const prompt = page.getByRole('region', { name: '登録確認' })
    await expect(prompt.getByRole('heading')).toHaveText('このプロジェクトを登録しますか？')
    await expect(prompt).toContainText(folder.root)
    await expect(prompt.getByRole('button', { name: '登録する' })).toBeVisible()

    await prompt.getByRole('button', { name: '登録しない' }).click()
    await expect(prompt).toContainText('このフォルダは登録しませんでした。')

    const readback = withDb((db) => getCandidate(db, candidate.id))
    expect(readback?.status).toBe('declined')
    expect(readback?.decisionAt).not.toBeNull()

    const projects = await page.request.get('/api/projects')
    const body = (await projects.json()) as Array<{ name: string }>
    expect(body.some((project) => project.name === 'candidate-decline')).toBe(false)
  } finally {
    folder.cleanup()
  }
})

test('reopens a declined candidate and reflects the status from the API', async ({ page }) => {
  const folder = createTempDir('adpt-e2e-cand-')
  try {
    const candidate = seedCandidate(folder.root, 'candidate-reopen')
    await page.goto(`/?candidate=${candidate.id}`)
    const prompt = page.getByRole('region', { name: '登録確認' })
    await prompt.getByRole('button', { name: '登録しない' }).click()
    await expect(prompt).toContainText('このフォルダは登録しませんでした。')

    const panel = page.getByRole('region', { name: '未登録の候補' })
    const row = panel.getByRole('listitem').filter({ hasText: 'candidate-reopen' })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'やり直す' }).click()

    await expect.poll(() => withDb((db) => getCandidate(db, candidate.id)?.status)).toBe('detected')

    const response = await page.request.get(`/api/candidates/${candidate.id}`)
    expect((await response.json()) as { status: string }).toMatchObject({ status: 'detected' })
  } finally {
    folder.cleanup()
  }
})

test('carries a failed candidate into the manual form without creating a project', async ({
  page,
}) => {
  const folder = createTempDir('adpt-e2e-cand-')
  try {
    const candidate = seedCandidate(folder.root, 'candidate-failed')
    withDb((db) => {
      beginRegistration(db, candidate.id)
      recordFailure(db, candidate.id, 'REMOTE_SETUP_FAILED', 'attempt 1')
      beginRegistration(db, candidate.id)
      recordFailure(db, candidate.id, 'REMOTE_SETUP_FAILED', 'attempt 2')
    })

    await page.goto('/')
    const panel = page.getByRole('region', { name: '未登録の候補' })
    const row = panel.getByRole('listitem').filter({ hasText: 'candidate-failed' })
    await expect(row).toContainText('REMOTE_SETUP_FAILED')
    await row.getByRole('button', { name: '手動で登録' }).click()

    await expect(page.getByLabel('プロジェクト名')).toHaveValue('candidate-failed')
    await expect(page.getByLabel('ローカルGit rootパス')).toHaveValue(folder.root)

    const projects = await page.request.get('/api/projects')
    const body = (await projects.json()) as Array<{ name: string }>
    expect(body.some((project) => project.name === 'candidate-failed')).toBe(false)
  } finally {
    folder.cleanup()
  }
})

test('shows no candidate panel when there are no candidates', async ({ page }) => {
  const ids = withDb((db) => listCandidates(db).map((candidate) => candidate.id))
  withDb((db) => {
    for (const id of ids) {
      db.prepare('DELETE FROM registration_candidates WHERE id = ?').run(id)
    }
  })

  await page.goto('/')
  await expect(page.getByRole('region', { name: '未登録の候補' })).toHaveCount(0)
})
