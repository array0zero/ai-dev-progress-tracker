import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/server/db/connection.js'
import { insertProject, type NewProject } from '../../src/server/db/project-repository.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

const SHA = 'a'.repeat(40)

function sampleProject(): NewProject {
  return {
    id: randomUUID(),
    name: 'sample',
    localPath: `/tmp/repo-${randomUUID()}`,
    repoNodeId: `node-${randomUUID()}`,
    repoOwner: 'octo',
    repoName: 'demo',
    repoUrl: 'https://github.com/octo/demo',
    defaultBranch: 'main',
    status: 'active',
  }
}

function seedCommit(ctx: TestDb, projectId: string): void {
  ctx.db
    .prepare(
      'INSERT INTO commits (project_id, sha, message, authored_at, detected_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(projectId, SHA, 'initial', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:01.000Z')
}

describe('db migrations v1', () => {
  let ctx: TestDb

  beforeEach(() => {
    ctx = createTestDb()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('applies schema v1 with every table to an empty database', () => {
    expect(ctx.db.prepare('SELECT version FROM schema_migrations').pluck().get()).toBe(1)

    const tables = ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all()
    expect(tables).toEqual(
      expect.arrayContaining([
        'projects',
        'commits',
        'evidence',
        'generation_runs',
        'run_evidence',
        'progress_snapshots',
        'backup_runs',
        'worker_leases',
      ]),
    )
  })

  it('does not re-apply the migration when the database is reopened', () => {
    ctx.db.close()
    const reopened = openDatabase(ctx.path)
    try {
      expect(reopened.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(1)
    } finally {
      reopened.close()
    }
  })

  it('rejects rows that violate a foreign key', () => {
    expect(() =>
      ctx.db
        .prepare(
          'INSERT INTO commits (project_id, sha, message, authored_at, detected_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('missing-project', SHA, 'm', 't', 't'),
    ).toThrow(/FOREIGN KEY/i)
  })

  it('enforces UNIQUE on local_path and repo_node_id', () => {
    const base = sampleProject()
    insertProject(ctx.db, base)

    expect(() =>
      insertProject(ctx.db, { ...base, id: randomUUID(), repoNodeId: `node-${randomUUID()}` }),
    ).toThrow(/UNIQUE/i)
    expect(() =>
      insertProject(ctx.db, { ...base, id: randomUUID(), localPath: `/tmp/other-${randomUUID()}` }),
    ).toThrow(/UNIQUE/i)
  })

  it('rejects invalid JSON in a progress snapshot column', () => {
    const project = sampleProject()
    insertProject(ctx.db, project)
    seedCommit(ctx, project.id)
    ctx.db
      .prepare(
        'INSERT INTO generation_runs (id, dedupe_key, project_id, commit_sha, mode, trigger, status, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('run-1', 'generation:x:y', project.id, SHA, 'generation', 'post_commit', 'queued', 't')

    expect(() =>
      ctx.db
        .prepare(
          `INSERT INTO progress_snapshots
             (id, generation_run_id, project_id, commit_sha, recovery_status,
              current_position_json, completed_items_json, next_actions_json, decisions_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('snap-1', 'run-1', project.id, SHA, 'complete', '{not json', '{}', '{}', '{}', 't'),
    ).toThrow()
  })
})

const V1_GOLDEN_FIXTURES = [
  'tests/fixtures/v1-compat/001_init.sql',
  'tests/fixtures/v1-compat/backup-v1.schema.json',
  'tests/fixtures/v1-compat/progress-output.schema.json',
] as const

describe('v1 physical contract: 001_init.sql', () => {
  const canonical = readFileSync(join(process.cwd(), 'db/migrations/001_init.sql'))
  const golden = readFileSync(join(process.cwd(), 'tests/fixtures/v1-compat/001_init.sql'))

  it('is byte-for-byte identical to the v1-compat golden copy', () => {
    expect(canonical.equals(golden)).toBe(true)
  })

  it('fails the comparison when a single byte differs', () => {
    const mutated = Buffer.from(canonical)
    mutated[0] = mutated[0] === 0x50 ? 0x20 : 0x50
    expect(mutated.equals(golden)).toBe(false)
  })

  it('loads into a fresh temp data dir as a working v1 schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adpt-v1golden-'))
    try {
      const db = new Database(join(dir, 'tracker.db'))
      try {
        db.exec(golden.toString('utf8'))
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .pluck()
          .all()
        expect(tables).toEqual(
          expect.arrayContaining([
            'projects',
            'commits',
            'evidence',
            'generation_runs',
            'run_evidence',
            'progress_snapshots',
            'backup_runs',
            'worker_leases',
          ]),
        )
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('v1 golden fixtures survive a real Git round trip', () => {
  it('returns the same bytes from git show HEAD:<path>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adpt-v1git-'))
    try {
      const git = (...args: string[]): Buffer =>
        execFileSync('git', args, { cwd: dir, maxBuffer: 8 * 1024 * 1024 })
      git('init', '-b', 'main')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test User')
      git('config', 'commit.gpgsign', 'false')
      git('config', 'core.autocrlf', 'false')

      for (const fixturePath of V1_GOLDEN_FIXTURES) {
        copyFileSync(join(process.cwd(), fixturePath), join(dir, basename(fixturePath)))
      }
      git('add', '.')
      git('commit', '-m', 'v1 golden fixtures')

      for (const fixturePath of V1_GOLDEN_FIXTURES) {
        const name = basename(fixturePath)
        const roundTripped = git('show', `HEAD:${name}`)
        expect(roundTripped.equals(readFileSync(join(process.cwd(), fixturePath)))).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
