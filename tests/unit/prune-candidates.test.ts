import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isExcludedProjectPath } from '../../src/cli/commands/agent-event.js'
import {
  findPrunableCandidates,
  runPruneCandidates,
} from '../../src/cli/commands/prune-candidates.js'
import {
  beginRegistration,
  listCandidates,
  markRegistered,
  upsertDetected,
} from '../../src/server/db/candidate-repository.js'
import { insertProject } from '../../src/server/db/project-repository.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

describe('isExcludedProjectPath', () => {
  it('excludes the OS temp directory and everything under it', () => {
    // 実運用で `…/AppData/Local/Temp/adpt-codex-*` が未登録候補に並んだ。
    expect(isExcludedProjectPath(tmpdir())).toBe(true)
    expect(isExcludedProjectPath(join(tmpdir(), 'adpt-codex-abc123'))).toBe(true)
    expect(isExcludedProjectPath(join(tmpdir(), 'adpt-codex-abc123', 'nested', 'deep'))).toBe(true)
  })

  it('excludes the home directory itself and the filesystem root', () => {
    expect(isExcludedProjectPath(homedir())).toBe(true)
    expect(isExcludedProjectPath(parse(process.cwd()).root)).toBe(true)
  })

  it('keeps a normal project folder', () => {
    expect(isExcludedProjectPath(process.cwd())).toBe(false)
    expect(isExcludedProjectPath(join(homedir(), 'work', 'demo'))).toBe(false)
  })

  it('does not treat a sibling whose name merely starts with the temp path as temp', () => {
    expect(isExcludedProjectPath(`${tmpdir()}-not-temp`)).toBe(false)
  })
})

describe('prune-candidates', () => {
  let ctx: TestDb
  let realDir: string

  beforeEach(() => {
    ctx = createTestDb()
    realDir = process.cwd()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  function detect(localPath: string): string {
    return upsertDetected(ctx.db, { localPath, agent: 'codex', suggestedName: 'x' }).id
  }

  it('selects temp and missing paths but keeps a live project folder', () => {
    const tempId = detect(join(tmpdir(), 'adpt-codex-zzz'))
    const goneDir = mkdtempSync(join(tmpdir(), 'adpt-prune-'))
    rmSync(goneDir, { recursive: true, force: true })
    detect(realDir)
    const missingId = detect(join(realDir, 'no-such-folder-9f2a'))

    expect(findPrunableCandidates(ctx.db).map((entry) => [entry.id, entry.reason])).toEqual(
      expect.arrayContaining([
        [tempId, 'excluded_path'],
        [missingId, 'missing_path'],
      ]),
    )
    expect(findPrunableCandidates(ctx.db)).toHaveLength(2)
  })

  it('never prunes a registered candidate', () => {
    const projectId = 'project-1'
    insertProject(ctx.db, {
      id: projectId,
      name: 'demo',
      localPath: join(tmpdir(), 'adpt-codex-registered'),
      repoNodeId: 'NODE_1',
      repoOwner: 'octo',
      repoName: 'demo',
      repoUrl: 'https://github.com/octo/demo',
      defaultBranch: 'main',
      status: 'active',
    })
    const id = detect(join(tmpdir(), 'adpt-codex-registered'))
    beginRegistration(ctx.db, id)
    expect(markRegistered(ctx.db, id, projectId)).toBe(true)

    expect(findPrunableCandidates(ctx.db)).toEqual([])
  })

  it('removes the selected rows and leaves the rest, and --dry-run removes nothing', () => {
    detect(join(tmpdir(), 'adpt-codex-yyy'))
    detect(realDir)

    expect(runPruneCandidates({ dryRun: true }, { db: ctx.db })).toBe(0)
    expect(listCandidates(ctx.db)).toHaveLength(2)

    expect(runPruneCandidates({}, { db: ctx.db })).toBe(0)
    expect(listCandidates(ctx.db).map((candidate) => candidate.localPath)).toEqual([realDir])
  })
})
