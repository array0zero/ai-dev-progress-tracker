import { randomUUID } from 'node:crypto'
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
