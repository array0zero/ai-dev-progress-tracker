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
