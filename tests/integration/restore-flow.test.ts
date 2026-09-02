import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../../src/server/config.js'
import { getBackupRunById } from '../../src/server/db/backup-repository.js'
import { openDatabase } from '../../src/server/db/connection.js'
import { insertProject, listProjects } from '../../src/server/db/project-repository.js'
import { insertRun, upsertCommit } from '../../src/server/db/run-repository.js'
import { BACKUP_TABLES } from '../../src/server/schemas/backup.js'
import {
  BACKUP_GITATTRIBUTES,
  createBackupExport,
  enqueueBackup,
  runBackup,
} from '../../src/server/services/backup-service.js'
import { areHooksInstalled } from '../../src/server/services/hook-service.js'
import { performRestore, restoreFromBackup } from '../../src/server/services/restore-service.js'
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js'
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

  it('restores a v1 backup with zero logical items missing', () => {
    seedSource(ctx)
    const { dataJson, manifestJson } = goodExport()
    const result = restoreFromBackup(dataJson, manifestJson, join(workDir, 'baseline.db'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    const restored = openDatabase(result.tempDbPath)
    try {
      const missing: string[] = []
      for (const table of BACKUP_TABLES) {
        const query = `SELECT ${table.columns.join(', ')} FROM ${table.table} ORDER BY ${table.orderBy}`
        const source = ctx.db.prepare(query).all()
        const target = restored.prepare(query).all()
        if (JSON.stringify(source) !== JSON.stringify(target)) {
          missing.push(table.key)
        }
      }
      expect(missing).toEqual([])
    } finally {
      restored.close()
    }
  })

  it('restores an empty v1 backup as an empty database', () => {
    const { dataJson, manifestJson } = goodExport()
    expect(JSON.parse(manifestJson)).toMatchObject({
      schemaVersion: 1,
      counts: {
        projects: 0,
        commits: 0,
        evidence: 0,
        generationRuns: 0,
        runEvidence: 0,
        progressSnapshots: 0,
      },
    })

    const result = restoreFromBackup(dataJson, manifestJson, join(workDir, 'empty.db'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const restored = openDatabase(result.tempDbPath)
    try {
      expect(listProjects(restored)).toEqual([])
      for (const table of BACKUP_TABLES) {
        const count = restored.prepare(`SELECT COUNT(*) AS n FROM ${table.table}`).get() as {
          n: number
        }
        expect(count.n).toBe(0)
      }
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

describe('performRestore (CLI orchestration)', () => {
  let ctx: TestDb
  let workDir: string
  let repo: TempRepo

  function config(): AppConfig {
    return {
      host: '127.0.0.1',
      port: 4317,
      dataDir: workDir,
      dbPath: join(workDir, 'tracker.db'),
      logsDir: join(workDir, 'logs'),
      logFilePath: join(workDir, 'logs', 'app.log'),
      webRoot: join(workDir, 'dist', 'web'),
    }
  }

  /** ctx.db を backup export し、config().dataDir/backup-repo へ manifest+data を用意する。 */
  function stageBackup(): void {
    const exported = createBackupExport(ctx.db, new Date('2026-09-01T12:00:00.000Z'))
    if (!exported.ok) {
      throw new Error('export failed')
    }
    const cloneDir = join(workDir, 'backup-repo')
    mkdirSync(join(cloneDir, 'data'), { recursive: true })
    mkdirSync(join(cloneDir, '.git'), { recursive: true })
    writeFileSync(join(cloneDir, 'manifest.json'), exported.manifestJson)
    writeFileSync(join(cloneDir, 'data', 'backup-v1.json'), exported.dataJson)
  }

  const overrides = {
    ensureRepo: async () => ({
      ok: true as const,
      slug: 'acme/ai-dev-progress-tracker-backup',
      created: false,
    }),
    syncClone: async () => true,
  }

  beforeEach(() => {
    ctx = createTestDb()
    workDir = mkdtempSync(join(tmpdir(), 'adpt-restore2-'))
    repo = createTempRepo({ origin: 'https://github.com/acme/widget.git' })
  })

  afterEach(() => {
    ctx.cleanup()
    repo.cleanup()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('restores every table and reinstalls hooks for a matching local repo', async () => {
    const projectId = randomUUID()
    insertProject(ctx.db, {
      id: projectId,
      name: 'widget',
      localPath: realpathSync(repo.root),
      repoNodeId: 'NODE_WIDGET',
      repoOwner: 'acme',
      repoName: 'widget',
      repoUrl: 'https://github.com/acme/widget',
      defaultBranch: 'main',
      status: 'active',
    })
    upsertCommit(ctx.db, {
      projectId,
      sha: SHA,
      parentSha: null,
      message: 'm',
      authoredAt: 't',
      detectedAt: 't',
    })
    stageBackup()

    const result = await performRestore(config(), overrides)
    expect(result).toMatchObject({ ok: true, exitCode: 0, restoredProjects: 1 })
    expect(result.reinstalledHooks).toEqual([projectId])

    const restored = openDatabase(config().dbPath)
    try {
      expect(listProjects(restored)).toHaveLength(1)
      expect((restored.prepare('SELECT COUNT(*) AS n FROM commits').get() as { n: number }).n).toBe(
        1,
      )
    } finally {
      restored.close()
    }
    expect(await areHooksInstalled(join(realpathSync(repo.root), '.git'), projectId)).toBe(true)
  })

  it('exits 2 and leaves the existing DB untouched without --force', async () => {
    seedSourceLocal(ctx)
    stageBackup()
    writeFileSync(config().dbPath, 'EXISTING_DB')

    const result = await performRestore(config(), overrides)
    expect(result).toMatchObject({ ok: false, exitCode: 2, code: 'DB_EXISTS' })
    expect(readFileSync(config().dbPath, 'utf8')).toBe('EXISTING_DB')
  })

  it('with --force moves the old DB aside and installs the restored one', async () => {
    seedSourceLocal(ctx)
    stageBackup()
    writeFileSync(config().dbPath, 'EXISTING_DB')

    const result = await performRestore(config(), { ...overrides, force: true })
    expect(result.ok).toBe(true)
    expect(result.preRestorePath).toBeTruthy()
    expect(readFileSync(result.preRestorePath ?? '', 'utf8')).toBe('EXISTING_DB')

    const restored = openDatabase(config().dbPath)
    try {
      expect(listProjects(restored).length).toBeGreaterThanOrEqual(1)
    } finally {
      restored.close()
    }
  })

  it('marks a project as local_missing when its local_path is gone, keeping its rows', async () => {
    const projectId = randomUUID()
    insertProject(ctx.db, {
      id: projectId,
      name: 'gone',
      localPath: '/no/such/path/for/restore',
      repoNodeId: 'NODE_GONE',
      repoOwner: 'acme',
      repoName: 'gone',
      repoUrl: 'https://github.com/acme/gone',
      defaultBranch: 'main',
      status: 'active',
    })
    upsertCommit(ctx.db, {
      projectId,
      sha: SHA,
      parentSha: null,
      message: 'm',
      authoredAt: 't',
      detectedAt: 't',
    })
    stageBackup()

    const result = await performRestore(config(), overrides)
    expect(result.ok).toBe(true)
    expect(result.localMissing).toEqual([projectId])

    const restored = openDatabase(config().dbPath)
    try {
      const projects = listProjects(restored)
      expect(projects[0]?.status).toBe('local_missing')
      expect((restored.prepare('SELECT COUNT(*) AS n FROM commits').get() as { n: number }).n).toBe(
        1,
      )
    } finally {
      restored.close()
    }
  })
})

describe('restore checksum across a real git round-trip', () => {
  let ctx: TestDb
  let workDir: string

  beforeEach(() => {
    ctx = createTestDb()
    workDir = mkdtempSync(join(tmpdir(), 'adpt-rt-'))
  })

  afterEach(() => {
    ctx.cleanup()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('matches the manifest checksum after a clone with core.autocrlf=true', async () => {
    const projectId = randomUUID()
    insertProject(ctx.db, {
      id: projectId,
      name: 'roundtrip',
      localPath: `/seed/${projectId}`,
      repoNodeId: `NODE_${projectId}`,
      repoOwner: 'seed',
      repoName: 'demo',
      repoUrl: 'https://github.com/seed/demo',
      defaultBranch: 'main',
      status: 'active',
    })
    const sha = 'a'.repeat(40)
    upsertCommit(ctx.db, {
      projectId,
      sha,
      parentSha: null,
      message: 'seed',
      authoredAt: '2026-09-01T00:00:00.000Z',
      detectedAt: '2026-09-01T00:00:01.000Z',
    })

    // 実 backup repo の代わりに bare repo を用意し、実 git で push する。
    const originDir = join(workDir, 'origin.git')
    execFileSync('git', ['init', '-b', 'main', '--bare', originDir])

    const enq = enqueueBackup(ctx.db, {
      trigger: 'pre_push',
      projectId,
      sourceCommitSha: sha,
      backupRepo: 'seed/backup',
    })
    const run = getBackupRunById(ctx.db, enq.runId)
    if (run === null) {
      throw new Error('run missing')
    }
    await runBackup(ctx.db, run, {
      cloneDir: join(workDir, 'backup-repo'),
      settleTimeoutMs: 2_000,
      settlePollMs: 20,
      ensureRepo: async () => ({ ok: true as const, slug: 'seed/backup', created: false }),
      repoUrlFor: () => originDir,
    })
    expect(getBackupRunById(ctx.db, run.id)?.status).toBe('succeeded')

    // Windows 相当の consumer: core.autocrlf=true で clone し直す。
    const consumerDir = join(workDir, 'consumer')
    execFileSync('git', ['-c', 'core.autocrlf=true', 'clone', originDir, consumerDir])

    const dataJson = readFileSync(join(consumerDir, 'data', 'backup-v1.json'), 'utf8')
    const manifestJson = readFileSync(join(consumerDir, 'manifest.json'), 'utf8')

    // `.gitattributes` があり、backup-v1.json は CRLF に化けていない
    expect(readFileSync(join(consumerDir, '.gitattributes'), 'utf8')).toBe(BACKUP_GITATTRIBUTES)
    expect(dataJson).not.toContain('\r\n')

    const result = restoreFromBackup(dataJson, manifestJson, join(workDir, 'rt.db'))
    expect(result).toMatchObject({ ok: true })
  })
})

function seedSourceLocal(ctx: TestDb): string {
  const projectId = randomUUID()
  insertProject(ctx.db, {
    id: projectId,
    name: 'x',
    localPath: '/no/such/path/seed',
    repoNodeId: `NODE_${projectId}`,
    repoOwner: 'acme',
    repoName: 'x',
    repoUrl: 'https://github.com/acme/x',
    defaultBranch: 'main',
    status: 'active',
  })
  return projectId
}

describe('v1 physical contract: backup-v1.schema.json', () => {
  const canonical = readFileSync(join(process.cwd(), 'schemas/backup-v1.schema.json'))
  const golden = readFileSync(join(process.cwd(), 'tests/fixtures/v1-compat/backup-v1.schema.json'))

  it('is byte-for-byte identical to the v1-compat golden copy', () => {
    expect(canonical.equals(golden)).toBe(true)
  })

  it('fails the comparison when a single byte differs', () => {
    const mutated = Buffer.from(canonical)
    mutated[0] = mutated[0] === 0x7b ? 0x20 : 0x7b
    expect(mutated.equals(golden)).toBe(false)
  })
})
