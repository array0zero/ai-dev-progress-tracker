import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeLocalRepository,
  getHeadCommit,
  initRepository,
  lsRemoteSha,
  pushInitial,
} from '../adapters/git.js'
import {
  checkAuth,
  createPrivateRepoFromSource,
  getActiveLogin,
  viewRepo,
} from '../adapters/github.js'
import {
  beginRegistration,
  getCandidate,
  markRegistered,
  recordFailure,
} from '../db/candidate-repository.js'
import type { Db } from '../db/connection.js'
import {
  findProjectByLocalPath,
  findProjectByRepoNodeId,
  insertProject,
} from '../db/project-repository.js'
import { upsertCommit } from '../db/run-repository.js'
import { BACKUP_REPO_SUFFIX, enqueueBackup, startBackupWorker } from './backup-service.js'
import { startGenerationWorker } from './generation-service.js'
import { assertHooksInstallable, installHooks } from './hook-service.js'
import { enqueueRecovery } from './recovery-service.js'

export const REGISTRATION_SCOPE = 'registration'
/** DESIGN「registration全体retry」: initial + 1 回、間隔 2 秒。変更しない。 */
export const REGISTRATION_RETRY_DELAY_MS = 2_000
export const SUMMARY_MAX_LENGTH = 240
const NAME_MAX_LENGTH = 100
const README_CANDIDATES = ['README.md', 'README.MD', 'readme.md', 'README', 'README.txt']

export interface RegistrationDeps {
  now?: () => Date
  /** retry 待ちの実体。テストで待たずに外部状態を変えるための seam。間隔自体は固定。 */
  sleep?: (ms: number) => Promise<void>
  /** false で登録後の recovery enqueue を抑止する (テスト用)。 */
  autoRecover?: boolean
  /** false で登録後の backup enqueue を抑止する (テスト用)。 */
  autoBackup?: boolean
  spawnWorker?: (scope: string, ownerToken: string) => void
}

export type RegistrationResult =
  | { ok: true; projectId: string }
  | { ok: false; code: string; message: string }

const MESSAGES: Record<string, string> = {
  NOT_GIT_ROOT: 'The candidate folder is not usable as a Git repository root.',
  GIT_LAYOUT_UNSUPPORTED:
    'This Git layout (linked worktree or non-standard .git) is not supported.',
  CUSTOM_HOOKS_PATH_UNSUPPORTED: 'Repositories with core.hooksPath configured are not supported.',
  REPOSITORY_MISMATCH: 'The origin remote is not a GitHub repository this app can use.',
  REPOSITORY_NAME_CONFLICT: 'A different repository with the generated name already exists.',
  GITHUB_AUTH_REQUIRED: 'GitHub CLI authentication is required.',
  GITHUB_REPOSITORY_CREATE_FAILED: 'Could not create the private GitHub repository.',
  REMOTE_SETUP_FAILED: 'Could not set up or verify the origin remote.',
  INITIAL_PUSH_FAILED: 'The initial push did not reach the remote branch.',
  HOOK_UNSUPPORTED: 'An existing Git hook without a shebang cannot be modified.',
  PROJECT_ALREADY_REGISTERED: 'This local path or repository is already registered.',
  CANDIDATE_NOT_FOUND: 'Candidate not found.',
  INTERNAL_ERROR: 'Registration failed.',
}

function fail(code: string): RegistrationResult {
  return { ok: false, code, message: MESSAGES[code] ?? MESSAGES.INTERNAL_ERROR ?? 'failed' }
}

/** DESIGN「GitHub repository名正規化」の 1〜9。10 (衝突) は呼び出し側で判定する。 */
export function normalizeRepositoryName(raw: string, candidateId: string): string {
  let value = raw.normalize('NFKC').trim()
  value = value.replace(/[A-Z]/g, (char) => char.toLowerCase())
  value = value.replace(/\s+/g, '-')
  value = value.replace(/[^a-z0-9._-]/g, '-')
  value = value.replace(/-{2,}/g, '-')
  value = value.replace(/^[.-]+|[.-]+$/g, '')
  value = value.slice(0, NAME_MAX_LENGTH).replace(/^[.-]+|[.-]+$/g, '')
  return value === '' ? `project-${candidateId.replace(/-/g, '').slice(0, 8)}` : value
}

/** DESIGN「summary登録時」の 1〜3。 */
export function buildSummary(description: string, readme: string | null, name: string): string {
  const fromDescription = description.trim()
  if (fromDescription !== '') {
    return fromDescription.slice(0, SUMMARY_MAX_LENGTH)
  }
  if (readme !== null) {
    for (const block of readme.split(/\n\s*\n/)) {
      const text = block.trim()
      if (text === '' || text.startsWith('#')) {
        continue
      }
      return text.replace(/\s+/g, ' ').slice(0, SUMMARY_MAX_LENGTH)
    }
  }
  return name.slice(0, SUMMARY_MAX_LENGTH)
}

function readReadme(root: string): string | null {
  for (const name of README_CANDIDATES) {
    const path = join(root, name)
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * DESIGN「GitHub自動登録state machine」1〜12。
 * 失敗はすべて固定 error code で返し、candidate 側の attempt 管理は worker が行う。
 */
export async function runRegistration(
  db: Db,
  candidateId: string,
  deps: RegistrationDeps = {},
): Promise<RegistrationResult> {
  const now = deps.now ?? (() => new Date())
  const candidate = getCandidate(db, candidateId)
  if (candidate === null) {
    return fail('CANDIDATE_NOT_FOUND')
  }

  // 1〜3: canonical path / Git root / 未初期化なら git init -b main
  let state = await describeLocalRepository(candidate.localPath)
  if (state.root === null) {
    if (!existsSync(candidate.localPath) || !(await initRepository(candidate.localPath))) {
      return fail('NOT_GIT_ROOT')
    }
    state = await describeLocalRepository(candidate.localPath)
    if (state.root === null) {
      return fail('NOT_GIT_ROOT')
    }
  }
  const root = state.root
  // home そのもの / filesystem root を project root にしない。
  // (temp 配下は実機テストで使うので許可する)
  const sameDir = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (sameDir(root, homedir()) || sameDir(root, parse(root).root)) {
    return fail('NOT_GIT_ROOT')
  }
  if (state.gitDir === null || state.gitDir !== join(root, '.git')) {
    return fail('GIT_LAYOUT_UNSUPPORTED')
  }
  if (state.customHooksPath) {
    return fail('CUSTOM_HOOKS_PATH_UNSUPPORTED')
  }

  // 4/5: origin あり = 既存 repo 照合、origin なし = Private repo 作成
  let slug: string
  let isNewRepo = false
  if (state.hasOrigin) {
    if (state.origin === null) {
      return fail('REPOSITORY_MISMATCH')
    }
    slug = `${state.origin.owner}/${state.origin.repo}`
  } else {
    if (!(await checkAuth())) {
      return fail('GITHUB_AUTH_REQUIRED')
    }
    const login = await getActiveLogin()
    if (login === null) {
      return fail('GITHUB_AUTH_REQUIRED')
    }
    const name = normalizeRepositoryName(candidate.suggestedName, candidate.id)
    slug = `${login}/${name}`
    // 同名 repo が既にあるなら suffix を作らず衝突として止める (DESIGN D008)。
    if ((await viewRepo(slug)).ok) {
      return fail('REPOSITORY_NAME_CONFLICT')
    }
    if (!(await createPrivateRepoFromSource(slug, root))) {
      return fail('GITHUB_REPOSITORY_CREATE_FAILED')
    }
    isNewRepo = true
  }

  const repoView = await viewRepo(slug)
  if (!repoView.ok) {
    return fail(isNewRepo ? 'GITHUB_REPOSITORY_CREATE_FAILED' : 'REPOSITORY_MISMATCH')
  }
  if (isNewRepo && repoView.repo.visibility.toUpperCase() !== 'PRIVATE') {
    return fail('GITHUB_REPOSITORY_CREATE_FAILED')
  }
  if (repoView.repo.nameWithOwner.toLowerCase() !== slug.toLowerCase()) {
    return fail('REMOTE_SETUP_FAILED')
  }

  // 6〜8: HEAD あり かつ 新規 repo のときだけ初回 push し、remote SHA を読み直す
  const after = await describeLocalRepository(root)
  if (isNewRepo && !after.hasOrigin) {
    return fail('REMOTE_SETUP_FAILED')
  }
  const headSha = after.headSha
  if (headSha !== null && isNewRepo) {
    const branch = after.branch ?? repoView.repo.defaultBranch ?? 'main'
    if (!(await pushInitial(root, branch))) {
      return fail('INITIAL_PUSH_FAILED')
    }
    if ((await lsRemoteSha(root, branch)) !== headSha) {
      return fail('INITIAL_PUSH_FAILED')
    }
  }

  // 9: project 登録 + hook 設置
  if (
    findProjectByLocalPath(db, root) !== null ||
    findProjectByRepoNodeId(db, repoView.repo.id) !== null
  ) {
    return fail('PROJECT_ALREADY_REGISTERED')
  }
  const hookPreflight = await assertHooksInstallable(join(root, '.git'))
  if (!hookPreflight.ok) {
    return fail('HOOK_UNSUPPORTED')
  }

  const [owner, name] = repoView.repo.nameWithOwner.split('/')
  const timestamp = now()
  const project = insertProject(
    db,
    {
      id: randomUUID(),
      name: candidate.suggestedName,
      localPath: root,
      repoNodeId: repoView.repo.id,
      repoOwner: owner ?? '',
      repoName: name ?? '',
      repoUrl: repoView.repo.url,
      defaultBranch: repoView.repo.defaultBranch ?? 'main',
      status: 'active',
      summary: buildSummary(repoView.repo.description, readReadme(root), candidate.suggestedName),
      registrationSource: candidate.agent,
    },
    timestamp,
  )

  const hookResult = await installHooks(join(root, '.git'), project.id)
  if (!hookResult.ok) {
    return fail('HOOK_UNSUPPORTED')
  }

  const iso = timestamp.toISOString()
  if (headSha !== null) {
    const head = await getHeadCommit(root)
    if (head !== null && head.sha !== '') {
      upsertCommit(db, {
        projectId: project.id,
        sha: head.sha,
        parentSha: head.parentSha,
        message: head.message,
        authoredAt: head.authoredAt !== '' ? head.authoredAt : iso,
        detectedAt: iso,
      })
    }
  }

  // 10: HEAD ありのときだけ recovery。HEAD なしは generation を作らない。
  if (deps.autoRecover !== false && headSha !== null) {
    const recovery = enqueueRecovery(db, project.id, 'registration', now)
    if (recovery.ok && recovery.shouldSpawn && recovery.ownerToken !== null) {
      startGenerationWorker(db, recovery.scope, recovery.ownerToken, recovery.runId, {
        spawnWorker: deps.spawnWorker,
      })
    }
  }

  // 11: registration 契機の backup
  if (deps.autoBackup !== false && headSha !== null) {
    const login = await getActiveLogin()
    const backupRepo = login === null ? BACKUP_REPO_SUFFIX : `${login}/${BACKUP_REPO_SUFFIX}`
    const backup = enqueueBackup(
      db,
      {
        trigger: 'registration',
        projectId: project.id,
        sourceCommitSha: headSha,
        backupRepo,
      },
      now,
    )
    if (backup.shouldSpawn && backup.ownerToken !== null) {
      startBackupWorker(db, backup.ownerToken, backup.runId, { spawnWorker: deps.spawnWorker })
    }
  }

  // 12: candidate を registered へ
  markRegistered(db, candidate.id, project.id)
  return { ok: true, projectId: project.id }
}

/** 1 attempt を実行し、失敗を candidate へ記録する。retry 制御は worker が行う。 */
export async function runRegistrationAttempt(
  db: Db,
  candidateId: string,
  deps: RegistrationDeps = {},
): Promise<RegistrationResult> {
  let result: RegistrationResult
  try {
    result = await runRegistration(db, candidateId, deps)
  } catch {
    result = fail('INTERNAL_ERROR')
  }
  if (!result.ok) {
    recordFailure(db, candidateId, result.code, result.message)
  }
  return result
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * DESIGN「registration全体retry」: attempt1 失敗 → error 保存 → 2 秒 → attempt2 → 失敗なら failed。
 * worker 再起動で attempt1 済み (error あり) の candidate を拾った場合は残り 1 回だけ実行する。
 */
export async function runRegistrationCycle(
  db: Db,
  candidateId: string,
  deps: RegistrationDeps = {},
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep
  const candidate = getCandidate(db, candidateId)
  if (candidate === null || candidate.status !== 'registering') {
    return
  }

  // 再起動で拾った attempt1 済みの candidate。2 秒待って attempt2 だけを実行する。
  if (candidate.lastErrorCode !== null) {
    const elapsed =
      candidate.decisionAt === null
        ? REGISTRATION_RETRY_DELAY_MS
        : Date.now() - Date.parse(candidate.decisionAt)
    if (elapsed < REGISTRATION_RETRY_DELAY_MS) {
      await sleep(REGISTRATION_RETRY_DELAY_MS - elapsed)
    }
    if (beginRegistration(db, candidateId)) {
      await runRegistrationAttempt(db, candidateId, deps)
    }
    return
  }

  const first = await runRegistrationAttempt(db, candidateId, deps)
  if (first.ok) {
    return
  }
  await sleep(REGISTRATION_RETRY_DELAY_MS)
  if (beginRegistration(db, candidateId)) {
    await runRegistrationAttempt(db, candidateId, deps)
  }
}

function workerEntryPath(): string {
  return fileURLToPath(new URL('../../worker/index.js', import.meta.url))
}

function defaultSpawnWorker(scope: string, token: string): void {
  const child = spawn(process.execPath, [workerEntryPath(), '--scope', scope, '--token', token], {
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => undefined)
  child.unref()
}

/** 承認された candidate 用の detached worker を起動する。spawn 失敗は candidate の error として残す。 */
export function startRegistrationWorker(
  db: Db,
  candidateId: string,
  deps: RegistrationDeps = {},
): void {
  try {
    ;(deps.spawnWorker ?? defaultSpawnWorker)(REGISTRATION_SCOPE, candidateId)
  } catch {
    recordFailure(db, candidateId, 'INTERNAL_ERROR', 'Failed to start the registration worker.')
  }
}
