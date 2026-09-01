import { expect, test } from '@playwright/test'
import { addRepoFixture } from '../helpers/fake-gh.js'
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js'

const FIXTURES_PATH = process.env.E2E_GH_FIXTURES ?? ''

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
