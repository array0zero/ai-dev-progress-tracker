import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPrivateRepo,
  ensureAuthSetupGit,
  getActiveLogin,
  viewRepo,
} from '../adapters/github.js'
import { runProcess } from '../adapters/process-runner.js'
import { loadConfig } from '../config.js'
import {
  type BackupRunRecord,
  getLatestSuccessfulBackupRun,
  insertBackupRun,
  markBackupRunTerminal,
} from '../db/backup-repository.js'
import type { Db } from '../db/connection.js'
import { LEASE_STALE_MS, releaseLease } from '../db/lease-repository.js'
import { hasActiveGenerationRuns, isGenerationTerminalForCommit } from '../db/run-repository.js'
import {
  BACKUP_APP_ID,
  BACKUP_SCHEMA_VERSION_V2,
  BACKUP_TABLES_V2,
  type BackupCountsV2,
  type BackupManifestV2,
  backupDataFileName,
} from '../schemas/backup.js'
import { containsHighConfidenceSecret } from '../security/redaction.js'

export const BACKUP_REPO_SUFFIX = 'ai-dev-progress-tracker-backup'
export const BACKUP_SCOPE = 'backup'
export const SETTLE_TIMEOUT_MS = 180_000
/** DESIGN.md「バックアップ先」: default branch は `main` 固定。初回 push でこの branch を作る。 */
export const BACKUP_BRANCH = 'main'
/**
 * backup repo の `.gitattributes`。manifest.json / data/backup-v2.json を
 * 改行変換なし (Windows の core.autocrlf 等の影響を受けない) で checkout させ、
 * 生成時に計算した sha256 と clone 後の byte 列を一致させる。末尾は LF 固定。
 */
export const BACKUP_GITATTRIBUTES = '* -text\n'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * DESIGN.md「バックアップファイル」の data 部を deterministic に生成する。
 * backup_runs / worker_leases / log / env は含めない。
 * 各テーブルは PK 昇順、UTF-8・2-space indent・末尾 LF。
 */
export function exportBackupData(db: Db): { dataJson: string; counts: BackupCountsV2 } {
  const data: Record<string, unknown[]> = {}
  const counts: Record<string, number> = {}
  // 列を明示して deterministic に出す。将来の追加列が黙って混ざらない。
  for (const { key, table, orderBy, columns } of BACKUP_TABLES_V2) {
    const rows = db
      .prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${orderBy}`)
      .all() as Record<string, unknown>[]
    data[key] = rows
    counts[key] = rows.length
  }
  return {
    dataJson: `${JSON.stringify(data, null, 2)}\n`,
    counts: counts as BackupCountsV2,
  }
}

export function buildBackupManifest(
  dataJson: string,
  counts: BackupCountsV2,
  now: Date,
): { manifest: BackupManifestV2; manifestJson: string } {
  const manifest: BackupManifestV2 = {
    appId: BACKUP_APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION_V2,
    createdAt: now.toISOString(),
    sha256: sha256Hex(dataJson),
    counts,
  }
  return { manifest, manifestJson: `${JSON.stringify(manifest, null, 2)}\n` }
}

export type BackupExportResult =
  | {
      ok: true
      dataJson: string
      manifestJson: string
      manifest: BackupManifestV2
      counts: BackupCountsV2
    }
  | { ok: false; code: 'SECRET_DETECTED' }

/** DB から backup export 一式を作る。export 文字列へ high-confidence scanner を再適用する。 */
export function createBackupExport(db: Db, now: Date = new Date()): BackupExportResult {
  const { dataJson, counts } = exportBackupData(db)
  if (containsHighConfidenceSecret(dataJson)) {
    return { ok: false, code: 'SECRET_DETECTED' }
  }
  const { manifest, manifestJson } = buildBackupManifest(dataJson, counts, now)
  return { ok: true, dataJson, manifestJson, manifest, counts }
}

export interface EnsureBackupRepoDeps {
  getActiveLogin: typeof getActiveLogin
  viewRepo: typeof viewRepo
  createPrivateRepo: typeof createPrivateRepo
  ensureAuthSetupGit: typeof ensureAuthSetupGit
}

const DEFAULT_ENSURE_DEPS: EnsureBackupRepoDeps = {
  getActiveLogin,
  viewRepo,
  createPrivateRepo,
  ensureAuthSetupGit,
}

export type EnsureBackupRepoResult =
  | { ok: true; slug: string; created: boolean }
  | { ok: false; code: string }

/**
 * `<gh active user>/ai-dev-progress-tracker-backup` を ensure する。
 * 既存なら visibility=PRIVATE を要求。なければ Private 作成。ensure 時に `gh auth setup-git`。
 * marker (manifest.json の appId) 検証は local clone を持つ T014 で行う。
 */
export async function ensureBackupRepo(
  deps: EnsureBackupRepoDeps = DEFAULT_ENSURE_DEPS,
): Promise<EnsureBackupRepoResult> {
  const login = await deps.getActiveLogin()
  if (login === null) {
    return { ok: false, code: 'GITHUB_AUTH_REQUIRED' }
  }
  const slug = `${login}/${BACKUP_REPO_SUFFIX}`

  const view = await deps.viewRepo(slug)
  if (view.ok) {
    if (view.repo.visibility.toUpperCase() !== 'PRIVATE') {
      return { ok: false, code: 'BACKUP_REPO_NOT_PRIVATE' }
    }
    await deps.ensureAuthSetupGit()
    return { ok: true, slug, created: false }
  }

  const created = await deps.createPrivateRepo(slug)
  if (!created) {
    return { ok: false, code: 'BACKUP_REPO_CREATE_FAILED' }
  }
  await deps.ensureAuthSetupGit()
  return { ok: true, slug, created: true }
}

// --- backup enqueue / worker spawn --------------------------------------------

export interface EnqueueBackupParams {
  trigger: 'registration' | 'pre_push' | 'manual'
  projectId: string | null
  sourceCommitSha: string | null
  backupRepo: string
}

export interface EnqueueBackupResult {
  runId: string
  shouldSpawn: boolean
  ownerToken: string | null
}

/**
 * backup run を queue し、同一 transaction 内で global `backup` lease を取得する。
 * 取得できた呼び出し元だけ `shouldSpawn=true`。
 */
export function enqueueBackup(
  db: Db,
  params: EnqueueBackupParams,
  now: () => Date = () => new Date(),
): EnqueueBackupResult {
  const ownerToken = randomUUID()
  const runId = randomUUID()

  const enqueue = db.transaction((): EnqueueBackupResult => {
    const current = now()
    const staleBefore = new Date(current.getTime() - LEASE_STALE_MS).toISOString()
    db.prepare('DELETE FROM worker_leases WHERE scope = ? AND heartbeat_at < ?').run(
      BACKUP_SCOPE,
      staleBefore,
    )

    insertBackupRun(
      db,
      {
        id: runId,
        trigger: params.trigger,
        projectId: params.projectId,
        sourceCommitSha: params.sourceCommitSha,
        backupRepo: params.backupRepo,
      },
      current,
    )

    const held = db.prepare('SELECT 1 FROM worker_leases WHERE scope = ?').get(BACKUP_SCOPE)
    if (held !== undefined) {
      return { runId, shouldSpawn: false, ownerToken: null }
    }
    db.prepare('INSERT INTO worker_leases (scope, owner_token, heartbeat_at) VALUES (?, ?, ?)').run(
      BACKUP_SCOPE,
      ownerToken,
      current.toISOString(),
    )
    return { runId, shouldSpawn: true, ownerToken }
  })

  return enqueue()
}

export interface BackupSpawnDeps {
  spawnWorker?: (scope: string, ownerToken: string) => void
}

function backupWorkerEntry(): string {
  return fileURLToPath(new URL('../../worker/index.js', import.meta.url))
}

function defaultSpawnBackupWorker(scope: string, ownerToken: string): void {
  const child = spawn(
    process.execPath,
    [backupWorkerEntry(), '--scope', scope, '--token', ownerToken],
    { detached: true, stdio: 'ignore' },
  )
  child.on('error', () => undefined)
  child.unref()
}

export function startBackupWorker(
  db: Db,
  ownerToken: string,
  originRunId: string,
  deps: BackupSpawnDeps = {},
): void {
  const doSpawn = deps.spawnWorker ?? defaultSpawnBackupWorker
  try {
    doSpawn(BACKUP_SCOPE, ownerToken)
  } catch {
    releaseLease(db, BACKUP_SCOPE, ownerToken)
    markBackupRunTerminal(db, originRunId, 'failed', {
      errorCode: 'WORKER_SPAWN_FAILED',
      errorMessage: 'Failed to start the backup worker.',
    })
  }
}

// --- backup run execution ----------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function git(
  args: readonly string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string }> {
  const result = await runProcess('git', args, { timeoutMs: 60_000, cwd })
  return { ok: !result.timedOut && result.code === 0, stdout: result.stdout.trim() }
}

export interface BackupGitDeps {
  clone: (repoUrl: string, dest: string) => Promise<boolean>
  pullFfOnly: (dir: string) => Promise<boolean>
  head: (dir: string) => Promise<string | null>
  commitPush: (dir: string, message: string) => Promise<{ ok: boolean; sha: string | null }>
}

const DEFAULT_GIT_DEPS: BackupGitDeps = {
  clone: async (repoUrl, dest) => (await git(['clone', repoUrl, dest])).ok,
  pullFfOnly: async (dir) => {
    if (!(await git(['-C', dir, 'pull', '--ff-only'])).ok) {
      return false
    }
    // `.gitattributes` (改行変換の無効化) が後から入った clone に備え、
    // 追跡ファイルを現在の属性で再展開する。best-effort。
    await git(['-C', dir, 'checkout', 'HEAD', '--', '.'])
    return true
  },
  head: async (dir) => {
    const r = await git(['-C', dir, 'rev-parse', 'HEAD'], dir)
    return r.ok ? r.stdout : null
  },
  commitPush: async (dir, message) => {
    // 初回 backup では clone 先が空 repo 由来の unborn HEAD (branch 名は git の
    // init.defaultBranch 依存)。DESIGN 固定の `main` へ寄せてから commit する。
    // 既に `main` の場合は no-op。symbolic-ref は index / working tree を触らない。
    await git(['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${BACKUP_BRANCH}`])
    if (!(await git(['-C', dir, 'add', '-A'])).ok) {
      return { ok: false, sha: null }
    }
    if (
      !(
        await git([
          '-C',
          dir,
          '-c',
          'user.email=backup@local',
          '-c',
          'user.name=adpt',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-m',
          message,
        ])
      ).ok
    ) {
      return { ok: false, sha: null }
    }
    // 初回 push で remote に `main` が無いため、明示 refspec + upstream 設定で push する。
    let pushed = (await git(['-C', dir, 'push', '-u', 'origin', BACKUP_BRANCH])).ok
    if (!pushed) {
      await sleep(2_000)
      pushed = (await git(['-C', dir, 'push', '-u', 'origin', BACKUP_BRANCH])).ok
    }
    const head = await git(['-C', dir, 'rev-parse', 'HEAD'])
    return { ok: pushed, sha: head.ok ? head.stdout : null }
  },
}

export interface RunBackupOptions {
  now?: () => Date
  /** backup repo の local clone 先。既定は `<TRACKER_DATA_DIR>/backup-repo`。 */
  cloneDir?: string
  settleTimeoutMs?: number
  settlePollMs?: number
  ensureRepo?: () => Promise<EnsureBackupRepoResult>
  repoUrlFor?: (slug: string) => string
  git?: BackupGitDeps
}

/** DESIGN.md: 対象 generation が terminal になるまで最大 settleTimeoutMs 待つ。 */
async function waitForGenerationSettled(
  db: Db,
  run: BackupRunRecord,
  timeoutMs: number,
  pollMs: number,
  now: () => Date,
): Promise<boolean> {
  const deadline = now().getTime() + timeoutMs
  for (;;) {
    const settled =
      run.trigger === 'manual'
        ? !hasActiveGenerationRuns(db)
        : run.projectId === null || run.sourceCommitSha === null
          ? true
          : isGenerationTerminalForCommit(db, run.projectId, run.sourceCommitSha)
    if (settled) {
      return true
    }
    if (now().getTime() >= deadline) {
      return false
    }
    await sleep(pollMs)
  }
}

/**
 * 1 件の backup run を実行する。
 * generation の settle 待ち → repo ensure → clone/pull → export(secret scan) →
 * 差分があれば commit/push。差分なしなら既存 HEAD を保存して succeeded。
 */
export async function runBackup(
  db: Db,
  run: BackupRunRecord,
  options: RunBackupOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date())
  const timeoutMs = options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS
  const pollMs = options.settlePollMs ?? 1_000
  const gitDeps = options.git ?? DEFAULT_GIT_DEPS
  const ensure = options.ensureRepo ?? (() => ensureBackupRepo())
  const repoUrlFor = options.repoUrlFor ?? ((slug: string) => `https://github.com/${slug}.git`)
  const cloneDir = options.cloneDir ?? join(loadConfig().dataDir, 'backup-repo')

  const fail = (code: string, message: string): void => {
    markBackupRunTerminal(db, run.id, 'failed', { errorCode: code, errorMessage: message }, now())
  }

  const settled = await waitForGenerationSettled(db, run, timeoutMs, pollMs, now)
  if (!settled) {
    fail('GENERATION_NOT_SETTLED', 'Generation did not reach a terminal state in time.')
    return
  }

  const repo = await ensure()
  if (!repo.ok) {
    fail(repo.code, 'Backup repository is not available.')
    return
  }

  mkdirSync(dirname(cloneDir), { recursive: true })
  if (!existsSync(join(cloneDir, '.git'))) {
    if (!(await gitDeps.clone(repoUrlFor(repo.slug), cloneDir))) {
      fail('BACKUP_CLONE_FAILED', 'Could not clone the backup repository.')
      return
    }
  } else if ((await gitDeps.head(cloneDir)) !== null && !(await gitDeps.pullFfOnly(cloneDir))) {
    // commit の無い backup repo (初回) は unborn HEAD で fast-forward 対象が無いため
    // pull しない。commit がある clone のみ pull し、失敗は致命とする。
    fail('BACKUP_PULL_FAILED', 'Could not fast-forward the backup clone.')
    return
  }

  // marker 検証: 既存 manifest.json があれば appId が一致すること。
  const manifestPath = join(cloneDir, 'manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as { appId?: unknown }
      if (existing.appId !== BACKUP_APP_ID) {
        fail('BACKUP_REPO_MARKER_MISMATCH', 'Backup repository marker does not match.')
        return
      }
    } catch {
      fail('BACKUP_REPO_MARKER_MISMATCH', 'Backup repository manifest is unreadable.')
      return
    }
  }

  const exported = createBackupExport(db, now())
  if (!exported.ok) {
    fail('SECRET_DETECTED', 'A secret-like value was detected; backup was not pushed.')
    return
  }

  // backup 対象ファイルは改行変換なしで clone させ、生成時 sha256 と byte 一致させる。
  // `.gitattributes` が未設置 (この修正より前に作られた repo) なら次回 backup で追加し、
  // 壊れた checkout 前提の backup を正しい状態へ置き換える。
  const attrPath = join(cloneDir, '.gitattributes')
  const attrInPlace =
    existsSync(attrPath) && readFileSync(attrPath, 'utf8') === BACKUP_GITATTRIBUTES

  const dataPath = join(cloneDir, 'data', backupDataFileName(BACKUP_SCHEMA_VERSION_V2))
  const previousData = existsSync(dataPath) ? readFileSync(dataPath, 'utf8') : null
  if (attrInPlace && previousData === exported.dataJson) {
    const head = await gitDeps.head(cloneDir)
    markBackupRunTerminal(db, run.id, 'succeeded', { backupCommitSha: head }, now())
    return
  }

  if (!attrInPlace) {
    writeFileSync(attrPath, BACKUP_GITATTRIBUTES, 'utf8')
  }
  mkdirSync(dirname(dataPath), { recursive: true })
  writeFileSync(manifestPath, exported.manifestJson, 'utf8')
  writeFileSync(dataPath, exported.dataJson, 'utf8')

  const pushed = await gitDeps.commitPush(cloneDir, `backup: ${exported.manifest.createdAt}`)
  if (!pushed.ok) {
    fail('BACKUP_PUSH_FAILED', 'Could not push the backup commit.')
    return
  }
  markBackupRunTerminal(db, run.id, 'succeeded', { backupCommitSha: pushed.sha }, now())
}

export { getLatestSuccessfulBackupRun }
