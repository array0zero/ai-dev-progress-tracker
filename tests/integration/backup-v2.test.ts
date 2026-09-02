import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  beginRegistration,
  listCandidates,
  recordFailure,
  upsertDetected,
} from '../../src/server/db/candidate-repository.js'
import { openDatabase } from '../../src/server/db/connection.js'
import { insertSnapshot } from '../../src/server/db/progress-repository.js'
import {
  getProjectById,
  insertProject,
  listProjects,
} from '../../src/server/db/project-repository.js'
import { insertRun, upsertCommit } from '../../src/server/db/run-repository.js'
import {
  BACKUP_TABLES,
  backupDataFileName,
  backupDataV2Schema,
  parseBackupManifest,
} from '../../src/server/schemas/backup.js'
import { containsHighConfidenceSecret } from '../../src/server/security/redaction.js'
import {
  BACKUP_GITATTRIBUTES,
  createBackupExport,
  exportBackupData,
} from '../../src/server/services/backup-service.js'
import { isUnreflected } from '../../src/server/services/freshness-service.js'
import { restoreFromBackup } from '../../src/server/services/restore-service.js'
import { createTestDb, createV1TestDb, type TestDb } from '../helpers/test-db.js'

const SHA = 'f'.repeat(40)

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('backup v2 export and v1/v2 restore', () => {
  let ctx: TestDb
  let workDir: string

  function seedV2(): { projectId: string; candidateId: string } {
    const projectId = randomUUID()
    insertProject(ctx.db, {
      id: projectId,
      name: 'v2 demo',
      localPath: `/v2/${projectId}`,
      repoNodeId: `NODE_${projectId}`,
      repoOwner: 'octo',
      repoName: 'demo',
      repoUrl: 'https://github.com/octo/demo',
      defaultBranch: 'main',
      status: 'active',
      summary: 'v2 の概要テキスト',
      registrationSource: 'codex',
      reviewRequired: true,
    })
    upsertCommit(ctx.db, {
      projectId,
      sha: SHA,
      parentSha: null,
      message: 'seed',
      authoredAt: '2026-09-02T00:00:00.000Z',
      detectedAt: '2026-09-02T00:00:01.000Z',
    })
    const runId = randomUUID()
    insertRun(ctx.db, {
      id: runId,
      dedupeKey: `generation:${projectId}:${SHA}`,
      projectId,
      commitSha: SHA,
      mode: 'generation',
      trigger: 'post_commit',
      detectedAt: '2026-09-02T00:00:02.000Z',
    })
    insertSnapshot(ctx.db, {
      id: randomUUID(),
      generationRunId: runId,
      projectId,
      commitSha: SHA,
      recoveryStatus: 'complete',
      currentPosition: { status: 'confirmed', text: '実装中', evidenceIds: [] },
      completedItems: { status: 'needs_input', items: [], evidenceIds: [] },
      nextActions: { status: 'needs_input', items: [], evidenceIds: [] },
      decisions: { status: 'needs_input', items: [], evidenceIds: [] },
    })

    const candidate = upsertDetected(ctx.db, {
      localPath: `/v2/candidate-${projectId}`,
      agent: 'claude',
      suggestedName: 'candidate demo',
    })
    beginRegistration(ctx.db, candidate.id)
    recordFailure(ctx.db, candidate.id, 'REMOTE_SETUP_FAILED', 'attempt 1 failed')
    return { projectId, candidateId: candidate.id }
  }

  beforeEach(() => {
    ctx = createTestDb()
    workDir = mkdtempSync(join(tmpdir(), 'adpt-backup-v2-'))
  })

  afterEach(() => {
    ctx.cleanup()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('exports schemaVersion 2 with the v2 project fields and candidates', () => {
    const { candidateId } = seedV2()
    const exported = createBackupExport(ctx.db, new Date('2026-09-02T12:00:00.000Z'))
    expect(exported.ok).toBe(true)
    if (!exported.ok) {
      return
    }

    const manifest = parseBackupManifest(JSON.parse(exported.manifestJson))
    expect(manifest?.version).toBe(2)
    expect(manifest?.manifest.counts).toMatchObject({ projects: 1, registrationCandidates: 1 })
    expect(backupDataFileName(2)).toBe('backup-v2.json')

    const data = backupDataV2Schema.parse(JSON.parse(exported.dataJson))
    expect(data.projects[0]).toMatchObject({
      summary: 'v2 の概要テキスト',
      registration_source: 'codex',
      review_required: 1,
    })
    expect(data.projects[0]?.review_required_at).not.toBeNull()
    expect(data.registrationCandidates[0]).toMatchObject({
      id: candidateId,
      agent: 'claude',
      status: 'registering',
      attempt_count: 1,
      last_error_code: 'REMOTE_SETUP_FAILED',
    })

    // 秘密面・運用テーブルは出さない
    expect(exported.dataJson).not.toContain('backup_runs')
    expect(exported.dataJson).not.toContain('worker_leases')
  })

  it('is deterministic and byte-identical for the same database', () => {
    seedV2()
    expect(exportBackupData(ctx.db).dataJson).toBe(exportBackupData(ctx.db).dataJson)
  })

  it('round-trips an empty database', () => {
    const exported = createBackupExport(ctx.db)
    expect(exported.ok).toBe(true)
    if (!exported.ok) {
      return
    }
    expect(exported.counts).toMatchObject({ projects: 0, registrationCandidates: 0 })

    const restored = restoreFromBackup(
      exported.dataJson,
      exported.manifestJson,
      join(workDir, 'empty.db'),
    )
    expect(restored.ok).toBe(true)
    if (!restored.ok) {
      return
    }
    const db = openDatabase(restored.tempDbPath)
    try {
      expect(listProjects(db)).toEqual([])
      expect(listCandidates(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('restores every v2 logical field including review, source and candidates', () => {
    const { projectId, candidateId } = seedV2()
    const exported = createBackupExport(ctx.db)
    if (!exported.ok) {
      throw new Error('export failed')
    }

    const restored = restoreFromBackup(
      exported.dataJson,
      exported.manifestJson,
      join(workDir, 'v2.db'),
    )
    expect(restored.ok).toBe(true)
    if (!restored.ok) {
      return
    }

    const db = openDatabase(restored.tempDbPath)
    try {
      expect(getProjectById(db, projectId)).toEqual(getProjectById(ctx.db, projectId))
      const candidate = listCandidates(db).find((item) => item.id === candidateId)
      expect(candidate).toEqual(listCandidates(ctx.db).find((item) => item.id === candidateId))

      // unreflected は保存せず、restore 後に commit/snapshot から再計算して一致する
      const before = isUnreflected(SHA, SHA)
      const commitSha = db.prepare('SELECT sha FROM commits LIMIT 1').pluck().get() as string
      const snapshotSha = db
        .prepare('SELECT commit_sha FROM progress_snapshots LIMIT 1')
        .pluck()
        .get() as string
      expect(isUnreflected(commitSha, snapshotSha)).toBe(before)
      expect(
        db
          .prepare("SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name = 'unreflected'")
          .pluck()
          .get(),
      ).toBe(0)
    } finally {
      db.close()
    }
  })

  it('still restores a v1 backup and fills the v2 columns with defaults', () => {
    // v1 の DB から v1 形式の backup を作る (v1 テーブル/列のみ)
    const v1 = createV1TestDb()
    const projectId = randomUUID()
    v1.db
      .prepare(
        `INSERT INTO projects
           (id, name, local_path, repo_node_id, repo_owner, repo_name, repo_url, default_branch, status, created_at, updated_at)
         VALUES (?, 'v1 project', ?, ?, 'octo', 'demo', 'https://github.com/octo/demo', 'main', 'active', ?, ?)`,
      )
      .run(
        projectId,
        `/v1/${projectId}`,
        `NODE_${projectId}`,
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z',
      )
    v1.db
      .prepare(
        'INSERT INTO commits (project_id, sha, parent_sha, message, authored_at, detected_at) VALUES (?, ?, NULL, ?, ?, ?)',
      )
      .run(projectId, SHA, 'v1 commit', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:01.000Z')

    const data: Record<string, unknown[]> = {}
    const counts: Record<string, number> = {}
    for (const { key, table, orderBy, columns } of BACKUP_TABLES) {
      const rows = v1.db
        .prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${orderBy}`)
        .all() as unknown[]
      data[key] = rows
      counts[key] = rows.length
    }
    const dataJson = `${JSON.stringify(data, null, 2)}\n`
    const manifestJson = `${JSON.stringify(
      {
        appId: 'ai-dev-progress-tracker',
        schemaVersion: 1,
        createdAt: '2026-09-01T12:00:00.000Z',
        sha256: createHash('sha256').update(dataJson, 'utf8').digest('hex'),
        counts,
      },
      null,
      2,
    )}\n`
    v1.cleanup()

    const restored = restoreFromBackup(dataJson, manifestJson, join(workDir, 'from-v1.db'))
    expect(restored.ok).toBe(true)
    if (!restored.ok) {
      return
    }
    expect(restored.manifest.schemaVersion).toBe(1)

    const db = openDatabase(restored.tempDbPath)
    try {
      // v1 の論理項目は欠損 0 件、v2 列は migration 002 の既定値
      expect(getProjectById(db, projectId)).toMatchObject({
        name: 'v1 project',
        summary: 'v1 project',
        registrationSource: 'manual',
        reviewRequired: false,
        reviewRequiredAt: null,
      })
      expect(db.prepare('SELECT COUNT(*) FROM commits').pluck().get()).toBe(1)
      expect(listCandidates(db)).toEqual([])
      expect(
        db.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all(),
      ).toEqual([1, 2])
    } finally {
      db.close()
    }
  })

  it('survives a real Git round trip through a bare backup repository', () => {
    const { projectId, candidateId } = seedV2()
    const exported = createBackupExport(ctx.db)
    if (!exported.ok) {
      throw new Error('export failed')
    }

    const bare = join(workDir, 'backup.git')
    const clone = join(workDir, 'clone')
    const fresh = join(workDir, 'fresh')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare])
    execFileSync('git', ['clone', bare, clone])
    git(clone, 'config', 'user.email', 'test@example.com')
    git(clone, 'config', 'user.name', 'Test User')
    git(clone, 'config', 'commit.gpgsign', 'false')

    writeFileSync(join(clone, '.gitattributes'), BACKUP_GITATTRIBUTES)
    mkdirSync(join(clone, 'data'), { recursive: true })
    writeFileSync(join(clone, 'manifest.json'), exported.manifestJson)
    writeFileSync(join(clone, 'data', 'backup-v2.json'), exported.dataJson)
    git(clone, 'add', '.')
    git(clone, 'commit', '-m', 'backup v2')
    git(clone, 'push', 'origin', 'HEAD')

    // fresh clone から読み直して checksum と論理項目を検証する
    execFileSync('git', ['clone', bare, fresh])
    const freshData = readFileSync(join(fresh, 'data', 'backup-v2.json'), 'utf8')
    const freshManifest = readFileSync(join(fresh, 'manifest.json'), 'utf8')
    expect(createHash('sha256').update(freshData, 'utf8').digest('hex')).toBe(
      exported.manifest.sha256,
    )

    const restored = restoreFromBackup(freshData, freshManifest, join(workDir, 'roundtrip.db'))
    expect(restored.ok).toBe(true)
    if (!restored.ok) {
      return
    }
    const db = openDatabase(restored.tempDbPath)
    try {
      expect(getProjectById(db, projectId)).toEqual(getProjectById(ctx.db, projectId))
      expect(listCandidates(db).map((item) => item.id)).toEqual([candidateId])
    } finally {
      db.close()
    }
  })

  it('never carries secrets, run bookkeeping or auth payloads into the backup', () => {
    const { projectId } = seedV2()
    // 保存前に redaction を通す経路 (commits.message) へ token を混ぜる
    upsertCommit(ctx.db, {
      projectId,
      sha: 'b'.repeat(40),
      parentSha: null,
      message: 'chore: rotate ghp_0123456789abcdefghijABCDEFGHIJKL',
      authoredAt: '2026-09-02T00:00:00.000Z',
      detectedAt: '2026-09-02T00:00:03.000Z',
    })
    ctx.db
      .prepare(
        "INSERT INTO backup_runs (id, trigger, project_id, source_commit_sha, backup_repo, status, queued_at) VALUES (?, 'manual', ?, NULL, 'octo/backup', 'succeeded', '2026-09-02T00:00:04.000Z')",
      )
      .run(randomUUID(), projectId)
    ctx.db
      .prepare(
        "INSERT INTO worker_leases (scope, owner_token, heartbeat_at) VALUES ('backup', 'secret-owner-token', '2026-09-02T00:00:05.000Z')",
      )
      .run()

    const exported = createBackupExport(ctx.db)
    expect(exported.ok).toBe(true)
    if (!exported.ok) {
      return
    }
    expect(exported.dataJson).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJKL')
    expect(exported.dataJson).not.toContain('secret-owner-token')
    expect(exported.dataJson).not.toContain('backupRuns')
    expect(exported.dataJson).not.toContain('workerLeases')
    expect(containsHighConfidenceSecret(exported.dataJson)).toBe(false)
    for (const key of ['authorization', 'cookie', 'api_key', 'access_token']) {
      expect(exported.dataJson.toLowerCase()).not.toContain(key)
    }
  })
})
