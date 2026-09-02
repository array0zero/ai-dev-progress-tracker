/**
 * 実機 GitHub で backup-v2 → clone → restore を往復検証する。CI では実行しない。
 *
 * 使い方:
 *   npm run real:backup-restore
 *
 * 隔離条件 (AGENTS.md):
 * - 触る GitHub repository は `<gh login>/ai-dev-progress-tracker-backup-e2e-fixture` だけ。
 *   production の `<gh login>/ai-dev-progress-tracker-backup` は読み取りもしない。
 * - fixture repo は Private + marker `.tracker-e2e-fixture` で所有を確認し、不一致なら無変更で停止。
 * - DB / clone は OS temp のみ。production の default repo 名は変更しない
 *   (`ensureRepo` injection で fixture slug を渡すだけ)。
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkAuth,
  createPrivateRepo,
  ensureAuthSetupGit,
  getActiveLogin,
  viewRepo,
} from '../src/server/adapters/github.js'
import { loadConfig } from '../src/server/config.js'
import { getBackupRunById } from '../src/server/db/backup-repository.js'
import {
  beginRegistration,
  listCandidates,
  recordFailure,
  upsertDetected,
} from '../src/server/db/candidate-repository.js'
import { type Db, openDatabase } from '../src/server/db/connection.js'
import { insertSnapshot } from '../src/server/db/progress-repository.js'
import { getProjectById, insertProject } from '../src/server/db/project-repository.js'
import { insertRun, upsertCommit } from '../src/server/db/run-repository.js'
import {
  BACKUP_REPO_SUFFIX,
  enqueueBackup,
  runBackup,
} from '../src/server/services/backup-service.js'
import { restoreFromBackup } from '../src/server/services/restore-service.js'

const FIXTURE_NAME = 'ai-dev-progress-tracker-backup-e2e-fixture'
const MARKER_FILE = '.tracker-e2e-fixture'
const MARKER_TEXT = 'ai-dev-progress-tracker backup e2e fixture repository\n'
const SHA = 'a1b2c3d4'.repeat(5)

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function seedDb(dir: string, withData: boolean): { db: Db; projectId: string | null } {
  const db = openDatabase(loadConfig({ TRACKER_DATA_DIR: dir }).dbPath)
  if (!withData) {
    return { db, projectId: null }
  }
  const projectId = randomUUID()
  insertProject(db, {
    id: projectId,
    name: 'real backup demo',
    localPath: join(dir, 'project'),
    repoNodeId: `NODE_${projectId}`,
    repoOwner: 'octo',
    repoName: 'demo',
    repoUrl: 'https://github.com/octo/demo',
    defaultBranch: 'main',
    status: 'active',
    summary: 'real backup roundtrip summary',
    registrationSource: 'codex',
    reviewRequired: true,
  })
  upsertCommit(db, {
    projectId,
    sha: SHA,
    parentSha: null,
    message: 'seed commit',
    authoredAt: '2026-09-02T00:00:00.000Z',
    detectedAt: '2026-09-02T00:00:01.000Z',
  })
  const runId = randomUUID()
  insertRun(db, {
    id: runId,
    dedupeKey: `generation:${projectId}:${SHA}`,
    projectId,
    commitSha: SHA,
    mode: 'generation',
    trigger: 'post_commit',
    detectedAt: '2026-09-02T00:00:02.000Z',
  })
  db.prepare("UPDATE generation_runs SET status = 'succeeded' WHERE id = ?").run(runId)
  insertSnapshot(db, {
    id: randomUUID(),
    generationRunId: runId,
    projectId,
    commitSha: SHA,
    recoveryStatus: 'complete',
    currentPosition: { status: 'confirmed', text: '実機 backup の現在地', evidenceIds: [] },
    completedItems: { status: 'needs_input', items: [], evidenceIds: [] },
    nextActions: { status: 'needs_input', items: [], evidenceIds: [] },
    decisions: { status: 'needs_input', items: [], evidenceIds: [] },
  })
  const candidate = upsertDetected(db, {
    localPath: join(dir, 'candidate'),
    agent: 'claude',
    suggestedName: 'real candidate',
  })
  beginRegistration(db, candidate.id)
  recordFailure(db, candidate.id, 'REMOTE_SETUP_FAILED', 'seeded failure')
  return { db, projectId }
}

async function pushBackup(db: Db, slug: string, cloneDir: string): Promise<string | null> {
  const queued = enqueueBackup(db, { trigger: 'manual', backupRepo: slug })
  const run = getBackupRunById(db, queued.runId)
  if (run === null) {
    return null
  }
  await runBackup(db, run, {
    cloneDir,
    ensureRepo: async () => ({ ok: true, slug }),
  })
  const finished = getBackupRunById(db, queued.runId)
  return finished?.status === 'succeeded' ? (finished.backupCommitSha ?? '') : null
}

async function main(): Promise<number> {
  const report: Record<string, unknown> = { tool: 'real:backup-restore' }
  const cleanup: string[] = []

  try {
    if (!(await checkAuth())) {
      report.result = 'STOP: GITHUB_AUTH_REQUIRED'
      return finish(report, 1)
    }
    const login = await getActiveLogin()
    if (login === null) {
      report.result = 'STOP: could not resolve the active gh login'
      return finish(report, 1)
    }
    const slug = `${login}/${FIXTURE_NAME}`
    const productionSlug = `${login}/${BACKUP_REPO_SUFFIX}`
    report.fixtureRepo = slug
    report.productionRepoUntouched = slug !== productionSlug
    if (slug === productionSlug) {
      report.result = 'STOP: the fixture slug collides with the production backup repo'
      return finish(report, 1)
    }
    await ensureAuthSetupGit()

    const existing = await viewRepo(slug)
    report.fixtureExisted = existing.ok
    if (existing.ok && existing.repo.visibility.toUpperCase() !== 'PRIVATE') {
      report.result = 'STOP: the fixture backup repository is not private; nothing was modified'
      return finish(report, 1)
    }
    if (!existing.ok && !(await createPrivateRepo(slug))) {
      report.result = 'FAIL: could not create the private fixture backup repository'
      return finish(report, 1)
    }

    const repoUrl = `https://github.com/${slug}.git`
    const markerDir = tempDir('adpt-real-backup-marker-')
    cleanup.push(markerDir)
    const markerClone = join(markerDir, 'repo')
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', repoUrl, markerClone], {
      encoding: 'utf8',
    })
    git(markerClone, 'config', 'user.email', 'e2e@example.com')
    git(markerClone, 'config', 'user.name', 'tracker e2e')
    git(markerClone, 'config', 'commit.gpgsign', 'false')

    const markerPath = join(markerClone, MARKER_FILE)
    if (existsSync(markerPath)) {
      report.markerPresent = true
    } else if (existsSync(join(markerClone, 'manifest.json'))) {
      // marker が無い backup repo は fixture 所有と確認できない (production かもしれない)。
      report.result = `STOP: ${MARKER_FILE} is missing in an existing backup repository; nothing was modified`
      return finish(report, 1)
    } else {
      writeFileSync(markerPath, MARKER_TEXT)
      git(markerClone, 'add', '.')
      git(markerClone, 'commit', '-m', 'e2e fixture marker')
      git(markerClone, 'push', 'origin', 'HEAD:main')
      report.markerPresent = true
      report.markerCreated = true
    }

    // 1. v2 データを seed して fixture repo へ push
    const dataDir = tempDir('adpt-real-backup-data-')
    const cloneDir = join(tempDir('adpt-real-backup-clone-'), 'backup-repo')
    cleanup.push(dataDir, cloneDir)
    const { db, projectId } = seedDb(dataDir, true)
    let sourceProject: unknown = null
    let sourceCandidates: unknown = null
    let backupCommit: string | null = null
    try {
      backupCommit = await pushBackup(db, slug, cloneDir)
      sourceProject = projectId === null ? null : getProjectById(db, projectId)
      sourceCandidates = listCandidates(db)
    } finally {
      db.close()
    }
    report.backupCommitSha = backupCommit
    if (backupCommit === null) {
      report.result = 'FAIL: the backup run did not succeed'
      return finish(report, 1)
    }

    // 2. fresh clone から checksum と restore を確認
    const freshDir = tempDir('adpt-real-backup-fresh-')
    cleanup.push(freshDir)
    const fresh = join(freshDir, 'fresh')
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', repoUrl, fresh])
    const dataJson = readFileSync(join(fresh, 'data', 'backup-v2.json'), 'utf8')
    const manifestJson = readFileSync(join(fresh, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(manifestJson) as { sha256: string; schemaVersion: number }
    report.manifestSchemaVersion = manifest.schemaVersion
    report.checksumMatches =
      createHash('sha256').update(dataJson, 'utf8').digest('hex') === manifest.sha256
    if (report.checksumMatches !== true || manifest.schemaVersion !== 2) {
      report.result = 'FAIL: the fresh clone does not match the manifest'
      return finish(report, 1)
    }

    const restoreDir = tempDir('adpt-real-backup-restore-')
    cleanup.push(restoreDir)
    const restored = restoreFromBackup(dataJson, manifestJson, join(restoreDir, 'restored.db'))
    report.restoreOk = restored.ok
    if (!restored.ok) {
      report.restoreCode = restored.code
      report.result = 'FAIL: restore from the fresh clone failed'
      return finish(report, 1)
    }
    const restoredDb = openDatabase(restored.tempDbPath)
    try {
      const restoredProject = projectId === null ? null : getProjectById(restoredDb, projectId)
      report.projectMatches = JSON.stringify(restoredProject) === JSON.stringify(sourceProject)
      report.candidatesMatch =
        JSON.stringify(listCandidates(restoredDb)) === JSON.stringify(sourceCandidates)
    } finally {
      restoredDb.close()
    }
    if (report.projectMatches !== true || report.candidatesMatch !== true) {
      report.result = 'FAIL: restored logical items differ from the source database'
      return finish(report, 1)
    }

    // 3. 0 件 backup も同じ repo で往復できる
    const emptyData = tempDir('adpt-real-backup-empty-')
    const emptyClone = join(tempDir('adpt-real-backup-empty-clone-'), 'backup-repo')
    cleanup.push(emptyData, emptyClone)
    const { db: emptyDb } = seedDb(emptyData, false)
    let emptyCommit: string | null = null
    try {
      emptyCommit = await pushBackup(emptyDb, slug, emptyClone)
    } finally {
      emptyDb.close()
    }
    report.emptyBackupCommitSha = emptyCommit
    if (emptyCommit === null) {
      report.result = 'FAIL: the zero-project backup run did not succeed'
      return finish(report, 1)
    }

    const emptyFreshDir = tempDir('adpt-real-backup-empty-fresh-')
    cleanup.push(emptyFreshDir)
    const emptyFresh = join(emptyFreshDir, 'fresh')
    execFileSync('git', [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.eol=lf',
      'clone',
      repoUrl,
      emptyFresh,
    ])
    const emptyRestore = restoreFromBackup(
      readFileSync(join(emptyFresh, 'data', 'backup-v2.json'), 'utf8'),
      readFileSync(join(emptyFresh, 'manifest.json'), 'utf8'),
      join(emptyFreshDir, 'restored.db'),
    )
    report.emptyRestoreOk = emptyRestore.ok
    if (!emptyRestore.ok) {
      report.result = 'FAIL: restore of the zero-project backup failed'
      return finish(report, 1)
    }
    const emptyRestoredDb = openDatabase(emptyRestore.tempDbPath)
    try {
      report.emptyRestoredProjects = emptyRestoredDb
        .prepare('SELECT COUNT(*) FROM projects')
        .pluck()
        .get()
    } finally {
      emptyRestoredDb.close()
    }
    if (report.emptyRestoredProjects !== 0) {
      report.result = 'FAIL: the zero-project restore was not empty'
      return finish(report, 1)
    }

    report.result = 'PASS'
    return finish(report, 0)
  } finally {
    for (const dir of cleanup) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function finish(report: Record<string, unknown>, code: number): number {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return code
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
