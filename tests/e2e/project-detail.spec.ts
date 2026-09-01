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
