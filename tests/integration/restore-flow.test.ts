import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/server/db/connection.js'
import { insertProject, listProjects } from '../../src/server/db/project-repository.js'
import { insertRun, upsertCommit } from '../../src/server/db/run-repository.js'
import { createBackupExport } from '../../src/server/services/backup-service.js'
import { restoreFromBackup } from '../../src/server/services/restore-service.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

const SHA = 'd'.repeat(40)

function seedSource(ctx: TestDb): string {
  const projectId = randomUUID()
  insertProject(ctx.db, {
    id: projectId,
    name: 'restore demo',
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
  return projectId
}

describe('restore flow', () => {
  let ctx: TestDb
  let workDir: string

  beforeEach(() => {
    ctx = createTestDb()
    workDir = mkdtempSync(join(tmpdir(), 'adpt-restore-'))
  })

  afterEach(() => {
    ctx.cleanup()
    rmSync(workDir, { recursive: true, force: true })
  })

  function goodExport(): { dataJson: string; manifestJson: string } {
    const exported = createBackupExport(ctx.db, new Date('2026-09-01T12:00:00.000Z'))
    if (!exported.ok) {
      throw new Error('export failed')
    }
    return { dataJson: exported.dataJson, manifestJson: exported.manifestJson }
  }

  it('imports a valid backup 100% into a fresh temp database', () => {
    const projectId = seedSource(ctx)
    const { dataJson, manifestJson } = goodExport()
    const tempPath = join(workDir, 'restored.db')

    const result = restoreFromBackup(dataJson, manifestJson, tempPath)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    const restored = openDatabase(result.tempDbPath)
    try {
      const projects = listProjects(restored)
      expect(projects).toHaveLength(1)
      expect(projects[0]?.id).toBe(projectId)
      expect((restored.prepare('SELECT COUNT(*) AS n FROM commits').get() as { n: number }).n).toBe(
        1,
      )
      expect(
        (restored.prepare('SELECT COUNT(*) AS n FROM generation_runs').get() as { n: number }).n,
      ).toBe(1)
    } finally {
      restored.close()
    }
  })

  it('rejects a checksum mismatch', () => {
    seedSource(ctx)
    const { dataJson, manifestJson } = goodExport()
    const result = restoreFromBackup(`${dataJson} `, manifestJson, join(workDir, 'r.db'))
    expect(result).toMatchObject({ ok: false, code: 'BACKUP_CHECKSUM_MISMATCH' })
    expect(existsSync(join(workDir, 'r.db'))).toBe(false)
  })

  it('rejects a foreign-key violation', () => {
    seedSource(ctx)
    const { manifestJson } = goodExport()
    // commit が存在しない project を参照するように data を作り直し、manifest の sha256 を合わせる
    const data = {
      projects: [],
      commits: [
        {
          project_id: 'missing-project',
          sha: SHA,
          parent_sha: null,
          message: 'x',
          authored_at: 't',
          detected_at: 't',
        },
      ],
      evidence: [],
      generationRuns: [],
      runEvidence: [],
      progressSnapshots: [],
    }
    const dataJson = `${JSON.stringify(data, null, 2)}\n`
    const manifest = JSON.parse(manifestJson) as Record<string, unknown>
    manifest.sha256 = createHash('sha256').update(dataJson, 'utf8').digest('hex')
    manifest.counts = {
      projects: 0,
      commits: 1,
      evidence: 0,
      generationRuns: 0,
      runEvidence: 0,
      progressSnapshots: 0,
    }

    const result = restoreFromBackup(dataJson, JSON.stringify(manifest), join(workDir, 'fk.db'))
    expect(result).toMatchObject({ ok: false, code: 'BACKUP_FK_VIOLATION' })
    expect(existsSync(join(workDir, 'fk.db'))).toBe(false)
  })

  it('rejects a row-count mismatch', () => {
    seedSource(ctx)
    const { dataJson, manifestJson } = goodExport()
    const manifest = JSON.parse(manifestJson) as { counts: Record<string, number> }
    manifest.counts.projects = 99
    const result = restoreFromBackup(dataJson, JSON.stringify(manifest), join(workDir, 'c.db'))
    expect(result).toMatchObject({ ok: false, code: 'BACKUP_COUNT_MISMATCH' })
  })

  it('never touches an unrelated existing database file on failure', () => {
    seedSource(ctx)
    const { dataJson, manifestJson } = goodExport()
    const existingDb = join(workDir, 'tracker.db')
    writeFileSync(existingDb, 'ORIGINAL')

    const result = restoreFromBackup(`${dataJson}x`, manifestJson, join(workDir, 'temp.db'))
    expect(result.ok).toBe(false)
    expect(readFileSync(existingDb, 'utf8')).toBe('ORIGINAL')
    expect(existsSync(join(workDir, 'temp.db'))).toBe(false)
  })
})
