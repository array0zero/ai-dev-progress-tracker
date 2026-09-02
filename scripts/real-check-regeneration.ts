/**
 * 実機 Codex で「要確認 → 再生成 → 鮮度」を往復検証する。CI では実行しない。
 *
 * 使い方:
 *   npm run real:regeneration
 *
 * 隔離条件 (AGENTS.md):
 * - Git repo / DB / clone は OS temp のみ。対象 repository と利用者 data は変更しない。
 * - GitHub へは出ない (fake gh seam で issue/PR を空にする)。AI だけ実機 Codex。
 * - 自然言語の本文を事前 expected にしない。schema 適合 / status / evidence 整合 /
 *   commit SHA だけを機械判定する。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCodexReady } from '../src/server/adapters/codex.js'
import { loadConfig } from '../src/server/config.js'
import { type Db, openDatabase } from '../src/server/db/connection.js'
import {
  getLatestSnapshotByProject,
  readSnapshotView,
} from '../src/server/db/progress-repository.js'
import { getProjectById, setProjectReviewRequired } from '../src/server/db/project-repository.js'
import { getRunById } from '../src/server/db/run-repository.js'
import { progressOutputSchema } from '../src/server/schemas/progress.js'
import { isUnreflected } from '../src/server/services/freshness-service.js'
import { runGeneration } from '../src/server/services/generation-service.js'
import { registerProject } from '../src/server/services/project-service.js'
import { enqueueRecovery } from '../src/server/services/recovery-service.js'
import { writeFakeGh } from '../tests/helpers/fake-gh.js'

const SLUG = 'e2e/real-regeneration'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 実 Git repo を作り、内容のある commit を 1 つ積む。 */
function seedRepo(root: string, files: ReadonlyArray<[string, string]>, message: string): string {
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'e2e@example.com')
  git(root, 'config', 'user.name', 'tracker e2e')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'remote', 'add', 'origin', `https://github.com/${SLUG}.git`)
  for (const [path, content] of files) {
    writeFileSync(join(root, path), content)
  }
  git(root, 'add', '.')
  git(root, 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

interface CaseResult {
  runStatus: string | null
  runErrorCode: string | null
  snapshotCommitSha: string | null
  recoveryStatus: string | null
  schemaValid: boolean
  unknownEvidenceIds: string[]
  reviewRequiredAfter: boolean
  unreflectedAfter: boolean
}

async function runCase(
  label: string,
  files: ReadonlyArray<[string, string]>,
  message: string,
  cleanup: string[],
): Promise<CaseResult> {
  const repoRoot = tempDir(`adpt-real-regen-${label}-`)
  const dataDir = tempDir(`adpt-real-regen-${label}-data-`)
  cleanup.push(repoRoot, dataDir)
  seedRepo(repoRoot, files, message)

  const db: Db = openDatabase(loadConfig({ TRACKER_DATA_DIR: dataDir }).dbPath)
  try {
    const registered = await registerProject(
      { name: `real regen ${label}`, localPath: repoRoot, repository: SLUG },
      db,
      { autoRecover: false, autoBackup: false },
    )
    if (!registered.ok) {
      throw new Error(`registration failed: ${registered.code}`)
    }
    const projectId = registered.project.id

    // 要確認 → 手動再生成 (UI の「再生成」と同じ経路)
    setProjectReviewRequired(db, projectId, true)
    const queued = enqueueRecovery(db, projectId, 'manual_recovery')
    if (!queued.ok) {
      throw new Error(`recovery enqueue failed: ${queued.code}`)
    }
    const run = getRunById(db, queued.runId)
    if (run === null) {
      throw new Error('recovery run missing')
    }
    db.prepare("UPDATE generation_runs SET status = 'running' WHERE id = ?").run(run.id)

    await runGeneration(db, { ...run, status: 'running' })

    const finished = getRunById(db, run.id)
    const snapshot = getLatestSnapshotByProject(db, projectId)
    const view = snapshot === null ? null : readSnapshotView(snapshot)
    const schemaValid =
      snapshot !== null &&
      progressOutputSchema.safeParse({
        schemaVersion: 1,
        currentPosition: snapshot.currentPosition,
        completedItems: snapshot.completedItems,
        nextActions: snapshot.nextActions,
        importantDecisions: snapshot.decisions,
      }).success

    const available = new Set(
      db
        .prepare('SELECT evidence_id FROM run_evidence WHERE run_id = ?')
        .pluck()
        .all(run.id) as string[],
    )
    const unknownEvidenceIds = (view?.evidenceIds ?? []).filter((id) => !available.has(id))

    return {
      runStatus: finished?.status ?? null,
      runErrorCode: finished?.errorCode ?? null,
      snapshotCommitSha: snapshot?.commitSha ?? null,
      recoveryStatus: snapshot?.recoveryStatus ?? null,
      schemaValid,
      unknownEvidenceIds,
      reviewRequiredAfter: getProjectById(db, projectId)?.reviewRequired === true,
      // 生成後に local HEAD を取り直して鮮度を再計算する
      unreflectedAfter: isUnreflected(
        git(repoRoot, 'rev-parse', 'HEAD'),
        snapshot?.commitSha ?? null,
      ),
    }
  } finally {
    db.close()
  }
}

const SOURCE_FILE = `export interface Task {
  id: string
  title: string
  done: boolean
}

/** 完了済みを除いた作業一覧を返す。 */
export function pendingTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => !task.done)
}
`

const NOTES_FILE = `# 設計メモ

- 進捗一覧は SQLite の tasks テーブルを正本にする。
- 次は pendingTasks を dashboard の一覧 API へ接続する。
- 決定: 一覧の並びは updated_at の降順にする (利用者が最新から確認するため)。
`

async function main(): Promise<number> {
  const report: Record<string, unknown> = { tool: 'real:regeneration' }
  const cleanup: string[] = []

  const ready = await checkCodexReady()
  if (!ready.ok) {
    report.result = `STOP: Codex is not ready (${ready.code})`
    return finish(report, 1, cleanup)
  }
  report.codexVersion = ready.version

  // GitHub へは出ない: fake gh が issue/PR を空で返す
  const ghDir = tempDir('adpt-real-regen-gh-')
  cleanup.push(ghDir)
  const fakeGh = writeFakeGh(ghDir, {
    authStatusExitCode: 0,
    login: 'e2e',
    repos: {
      [SLUG]: {
        repoView: {
          id: 'NODE_REAL_REGEN',
          nameWithOwner: SLUG,
          url: `https://github.com/${SLUG}`,
          visibility: 'PRIVATE',
          defaultBranchRef: { name: 'main' },
          description: null,
        },
        issues: [],
        pulls: [],
      },
    },
  })
  for (const [key, value] of Object.entries(fakeGh.env)) {
    process.env[key] = value
  }

  const repoStatusBefore = execFileSync('git', ['status', '--porcelain'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })

  try {
    const rich = await runCase(
      'rich',
      [
        ['src-tasks.ts', SOURCE_FILE],
        ['NOTES.md', NOTES_FILE],
      ],
      'feat(tasks): 未完了タスク抽出を追加し一覧APIへ接続する準備をする',
      cleanup,
    )
    report.richEvidenceCase = rich

    const thin = await runCase('thin', [['bump.txt', 'v1\n']], 'chore: bump', cleanup)
    report.thinEvidenceCase = thin

    report.repoWorkingTreeUnchanged =
      execFileSync('git', ['status', '--porcelain'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }) === repoStatusBefore

    const failures: string[] = []
    for (const [label, result] of [
      ['rich', rich],
      ['thin', thin],
    ] as const) {
      // 根拠不足でも run を failed にせず snapshot を残す (v1.7 契約)
      if (result.runStatus === 'failed' || result.runStatus === null) {
        failures.push(`${label}: run status ${result.runStatus} (${result.runErrorCode})`)
      }
      if (result.snapshotCommitSha === null) {
        failures.push(`${label}: no snapshot was stored`)
      }
      if (!result.schemaValid) {
        failures.push(`${label}: snapshot does not match progress-output schema v1`)
      }
      if (result.unknownEvidenceIds.length > 0) {
        failures.push(`${label}: fabricated evidence ids ${result.unknownEvidenceIds.join(',')}`)
      }
      if (!result.reviewRequiredAfter) {
        failures.push(`${label}: reviewRequired was cleared automatically`)
      }
      if (result.unreflectedAfter) {
        failures.push(`${label}: snapshot commit does not match the local HEAD`)
      }
    }
    if (report.repoWorkingTreeUnchanged !== true) {
      failures.push('the target repository working tree changed')
    }

    report.failures = failures
    report.result = failures.length === 0 ? 'PASS' : 'FAIL'
    return finish(report, failures.length === 0 ? 0 : 1, cleanup)
  } catch (error) {
    report.result = `FAIL: ${error instanceof Error ? error.message : String(error)}`
    return finish(report, 1, cleanup)
  }
}

function finish(report: Record<string, unknown>, code: number, cleanup: string[]): number {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true })
  }
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
