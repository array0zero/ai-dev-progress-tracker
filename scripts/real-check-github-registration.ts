/**
 * 実機 GitHub で F3 (Private repo 作成 / origin / 初回 push) を往復検証する。CI では実行しない。
 *
 * 使い方:
 *   npm run real:github-registration
 *
 * 隔離条件 (AGENTS.md):
 * - 触る GitHub repository は `<gh login>/ai-dev-progress-tracker-e2e-fixture` だけ。
 * - 既存の場合は Private かつ marker `.tracker-e2e-fixture` が default branch にあることを確認し、
 *   一致しなければ何も変更せず停止する。
 * - local 側は OS temp のみ。recovery / backup は enqueue しない (Codex と production backup を触らない)。
 * - token は取得も保存もしない。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkAuth,
  ensureAuthSetupGit,
  getActiveLogin,
  viewRepo,
} from '../src/server/adapters/github.js'
import { loadConfig } from '../src/server/config.js'
import { beginRegistration, upsertDetected } from '../src/server/db/candidate-repository.js'
import { openDatabase } from '../src/server/db/connection.js'
import { listProjects } from '../src/server/db/project-repository.js'
import { runRegistration } from '../src/server/services/registration-service.js'

const FIXTURE_NAME = 'ai-dev-progress-tracker-e2e-fixture'
const MARKER_FILE = '.tracker-e2e-fixture'
const MARKER_TEXT = 'ai-dev-progress-tracker e2e fixture repository\n'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
}

function initLocalRepo(root: string): void {
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'e2e@example.com')
  git(root, 'config', 'user.name', 'tracker e2e')
  git(root, 'config', 'commit.gpgsign', 'false')
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function openTempDb(dir: string): ReturnType<typeof openDatabase> {
  return openDatabase(loadConfig({ TRACKER_DATA_DIR: dir }).dbPath)
}

async function approveAndRegister(
  dbDir: string,
  localPath: string,
  name: string,
): Promise<{ ok: boolean; code?: string; projects: number }> {
  const db = openTempDb(dbDir)
  try {
    const candidate = upsertDetected(db, { localPath, agent: 'codex', suggestedName: name })
    beginRegistration(db, candidate.id)
    const result = await runRegistration(db, candidate.id, {
      autoRecover: false,
      autoBackup: false,
    })
    return {
      ok: result.ok,
      code: result.ok ? undefined : result.code,
      projects: listProjects(db).length,
    }
  } finally {
    db.close()
  }
}

async function main(): Promise<number> {
  const report: Record<string, unknown> = { tool: 'real:github-registration' }
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
    report.fixtureRepo = slug

    const existing = await viewRepo(slug)
    report.fixtureExisted = existing.ok
    await ensureAuthSetupGit()

    const unique = `fixture-${Date.now()}.txt`
    const uniqueContent = `roundtrip ${new Date().toISOString()}\n`
    const workspace = tempDir('adpt-real-gh-repo-')
    const dataDir = tempDir('adpt-real-gh-data-')
    cleanup.push(workspace, dataDir)

    if (existing.ok) {
      // 既存 fixture repo: Private と marker で所有を確認してから使う。
      if (existing.repo.visibility.toUpperCase() !== 'PRIVATE') {
        report.result = 'STOP: the fixture repository is not private; nothing was modified'
        return finish(report, 1)
      }
      git(
        workspace,
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.eol=lf',
        'clone',
        existing.repo.url,
        'repo',
      )
      const root = join(workspace, 'repo')
      if (!existsSync(join(root, MARKER_FILE))) {
        report.result = `STOP: ${MARKER_FILE} is missing on the default branch; nothing was modified`
        return finish(report, 1)
      }
      git(root, 'config', 'user.email', 'e2e@example.com')
      git(root, 'config', 'user.name', 'tracker e2e')
      git(root, 'config', 'commit.gpgsign', 'false')
      writeFileSync(join(root, unique), uniqueContent)
      git(root, 'add', '.')
      git(root, 'commit', '-m', `e2e roundtrip ${unique}`)
      git(root, 'push', 'origin', 'HEAD')

      const registration = await approveAndRegister(dataDir, root, 'GitHub Fixture')
      report.registration = registration
      if (!registration.ok) {
        report.result = `FAIL: registration on the existing origin failed (${registration.code})`
        return finish(report, 1)
      }
      report.createdRepository = false
    } else {
      // 未作成: 自動登録の create + 初回 push 経路をそのまま実行する。
      const root = join(workspace, 'repo')
      execFileSync('git', ['init', '-b', 'main', root])
      initLocalRepo(root)
      writeFileSync(join(root, MARKER_FILE), MARKER_TEXT)
      writeFileSync(join(root, unique), uniqueContent)
      git(root, 'add', '.')
      git(root, 'commit', '-m', 'e2e fixture bootstrap')

      const registration = await approveAndRegister(dataDir, root, FIXTURE_NAME)
      report.registration = registration
      if (!registration.ok) {
        report.result = `FAIL: automatic registration failed (${registration.code})`
        return finish(report, 1)
      }
      report.createdRepository = true
    }

    const root = join(workspace, 'repo')
    const localHead = git(root, 'rev-parse', 'HEAD')
    const branch = git(root, 'symbolic-ref', '--short', 'HEAD')
    const remoteSha = git(root, 'ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/)[0]
    report.localHead = localHead
    report.remoteSha = remoteSha
    if (remoteSha !== localHead) {
      report.result = 'FAIL: the remote branch SHA does not match the local HEAD'
      return finish(report, 1)
    }

    // GitHub から取り直した内容が local と一致するか
    const view = await viewRepo(slug)
    if (!view.ok || view.repo.visibility.toUpperCase() !== 'PRIVATE') {
      report.result = 'FAIL: the fixture repository is not readable as a private repo'
      return finish(report, 1)
    }
    const freshDir = tempDir('adpt-real-gh-clone-')
    cleanup.push(freshDir)
    // Windows の core.autocrlf を無効にして clone し、push した bytes をそのまま比較する。
    git(freshDir, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', view.repo.url, 'fresh')
    const fresh = join(freshDir, 'fresh')
    report.freshCloneHead = git(fresh, 'rev-parse', 'HEAD')
    report.contentMatches = readFileSync(join(fresh, unique), 'utf8') === uniqueContent
    report.markerPresent = existsSync(join(fresh, MARKER_FILE))
    if (
      report.freshCloneHead !== localHead ||
      report.contentMatches !== true ||
      report.markerPresent !== true
    ) {
      report.result = 'FAIL: the fresh clone does not match what was pushed'
      return finish(report, 1)
    }

    // commit 0 件: 既存 origin を持つ空 repo は push せずに登録できる
    const emptyDir = tempDir('adpt-real-gh-empty-')
    const emptyData = tempDir('adpt-real-gh-empty-data-')
    cleanup.push(emptyDir, emptyData)
    const emptyRoot = join(emptyDir, 'repo')
    execFileSync('git', ['init', '-b', 'main', emptyRoot])
    initLocalRepo(emptyRoot)
    git(emptyRoot, 'remote', 'add', 'origin', view.repo.url)
    const beforeEmpty = git(emptyRoot, 'ls-remote', 'origin', `refs/heads/${branch}`).split(
      /\s+/,
    )[0]
    const emptyRegistration = await approveAndRegister(emptyData, emptyRoot, 'Empty Fixture')
    const afterEmpty = git(emptyRoot, 'ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/)[0]
    report.emptyRepoRegistration = emptyRegistration
    report.emptyRepoRemoteUnchanged = beforeEmpty === afterEmpty && afterEmpty === localHead
    if (!emptyRegistration.ok || report.emptyRepoRemoteUnchanged !== true) {
      report.result = 'FAIL: the zero-commit case did not register without pushing'
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
