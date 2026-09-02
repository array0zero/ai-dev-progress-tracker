import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { insertProject } from '../../src/server/db/project-repository.js'
import { insertRun, upsertCommit } from '../../src/server/db/run-repository.js'
import {
  createBackupExport,
  ensureBackupRepo,
  exportBackupData,
} from '../../src/server/services/backup-service.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

const SHA = 'b'.repeat(40)

function seed(ctx: TestDb): string {
  const projectId = randomUUID()
  insertProject(ctx.db, {
    id: projectId,
    name: 'demo',
    localPath: `/seed/${projectId}`,
    repoNodeId: `NODE_${projectId}`,
    repoOwner: 'seed',
    repoName: 'demo',
    repoUrl: 'https://github.com/seed/demo',
    defaultBranch: 'main',
    status: 'active',
  })
  upsertCommit(ctx.db, {
    projectId,
    sha: SHA,
    parentSha: null,
    message: 'seed',
    authoredAt: '2026-09-01T00:00:00.000Z',
    detectedAt: '2026-09-01T00:00:01.000Z',
  })
  insertRun(ctx.db, {
    id: randomUUID(),
    dedupeKey: `generation:${projectId}:${SHA}`,
    projectId,
    commitSha: SHA,
    mode: 'generation',
    trigger: 'post_commit',
    detectedAt: '2026-09-01T00:00:02.000Z',
  })
  // 非対象テーブルにも行を入れておく
  ctx.db
    .prepare(
      "INSERT INTO backup_runs (id, trigger, status, backup_repo, queued_at) VALUES (?, 'manual', 'queued', ?, ?)",
    )
    .run(randomUUID(), 'seed/ai-dev-progress-tracker-backup', '2026-09-01T00:00:03.000Z')
  ctx.db
    .prepare('INSERT INTO worker_leases (scope, owner_token, heartbeat_at) VALUES (?, ?, ?)')
    .run(`generation:${projectId}`, randomUUID(), '2026-09-01T00:00:04.000Z')
  return projectId
}

describe('backup export', () => {
  let ctx: TestDb

  beforeEach(() => {
    ctx = createTestDb()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('produces byte-identical data on repeated export of the same DB', () => {
    seed(ctx)
    const first = exportBackupData(ctx.db).dataJson
    const second = exportBackupData(ctx.db).dataJson
    expect(second).toBe(first)
    expect(first.endsWith('\n')).toBe(true)
  })

  it('excludes backup_runs / worker_leases and any secret material', () => {
    seed(ctx)
    const { dataJson } = exportBackupData(ctx.db)
    const parsed = JSON.parse(dataJson) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([
      'commits',
      'evidence',
      'generationRuns',
      'progressSnapshots',
      'projects',
      'runEvidence',
    ])
    expect(dataJson).not.toContain('worker_leases')
    expect(dataJson).not.toContain('owner_token')
    expect(dataJson).not.toContain('backup_repo')
  })

  it('fails with SECRET_DETECTED when a secret-like value is present in evidence', () => {
    const projectId = seed(ctx)
    ctx.db
      .prepare(
        `INSERT INTO evidence (id, project_id, kind, external_key, source_version, title, url, payload_json, captured_at)
         VALUES (?, ?, 'commit', ?, ?, 'leak', null, ?, ?)`,
      )
      .run(
        randomUUID(),
        projectId,
        SHA.slice(0, 7),
        SHA,
        JSON.stringify({ note: 'token ghp_0123456789abcdefghijABCDEFGHIJKL here' }),
        '2026-09-01T00:00:05.000Z',
      )
    expect(createBackupExport(ctx.db)).toEqual({ ok: false, code: 'SECRET_DETECTED' })
  })

  it('manifest sha256 matches the data and counts the exported rows', () => {
    seed(ctx)
    const result = createBackupExport(ctx.db, new Date('2026-09-01T12:00:00.000Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.manifest.sha256).toBe(
      createHash('sha256').update(result.dataJson, 'utf8').digest('hex'),
    )
    expect(result.manifest.appId).toBe('ai-dev-progress-tracker')
    expect(result.manifest.counts.projects).toBe(1)
    expect(result.manifest.counts.commits).toBe(1)
    expect(result.manifest.counts.generationRuns).toBe(1)
    expect(result.manifest.counts.progressSnapshots).toBe(0)
  })

  it('ensureBackupRepo rejects an existing non-private backup repo', async () => {
    const result = await ensureBackupRepo({
      getActiveLogin: async () => 'octocat',
      viewRepo: async () => ({
        ok: true,
        repo: {
          id: 'R',
          nameWithOwner: 'octocat/ai-dev-progress-tracker-backup',
          url: 'https://github.com/octocat/ai-dev-progress-tracker-backup',
          visibility: 'PUBLIC',
          defaultBranch: 'main',
          description: '',
        },
      }),
      createPrivateRepo: async () => true,
      ensureAuthSetupGit: async () => true,
    })
    expect(result).toEqual({ ok: false, code: 'BACKUP_REPO_NOT_PRIVATE' })
  })

  it('ensureBackupRepo creates a private repo when it does not exist', async () => {
    let createdSlug: string | null = null
    const result = await ensureBackupRepo({
      getActiveLogin: async () => 'octocat',
      viewRepo: async () => ({ ok: false, code: 'GITHUB_CLI_ERROR' }),
      createPrivateRepo: async (slug) => {
        createdSlug = slug
        return true
      },
      ensureAuthSetupGit: async () => true,
    })
    expect(result).toEqual({
      ok: true,
      slug: 'octocat/ai-dev-progress-tracker-backup',
      created: true,
    })
    expect(createdSlug).toBe('octocat/ai-dev-progress-tracker-backup')
  })
})
