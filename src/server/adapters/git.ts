import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { type RunResult, runProcess } from './process-runner.js'

const GIT_TIMEOUT_MS = 10_000

export interface GitHubSlug {
  owner: string
  repo: string
}

export type RepositoryInspectionErrorCode =
  | 'NOT_GIT_ROOT'
  | 'GIT_LAYOUT_UNSUPPORTED'
  | 'CUSTOM_HOOKS_PATH_UNSUPPORTED'
  | 'REPOSITORY_MISMATCH'

export interface RepositoryLayout {
  /** realpath of the Git working tree root */
  root: string
  /** realpath of the absolute git dir */
  gitDir: string
  /** GitHub owner/repo parsed from the origin URL. Raw origin URL is not retained. */
  origin: GitHubSlug
  headSha: string
}

export type RepositoryInspection =
  | { ok: true; layout: RepositoryLayout }
  | { ok: false; code: RepositoryInspectionErrorCode }

export interface CommitMetadata {
  sha: string
  parentSha: string | null
  message: string
  /** ISO-8601 UTC */
  authoredAt: string
}

function git(args: readonly string[]): Promise<RunResult> {
  return runProcess('git', args, { timeoutMs: GIT_TIMEOUT_MS })
}

/** HTTPS / SSH / scp-like の GitHub origin を owner/repo へ正規化する。 */
export function normalizeGitHubOrigin(raw: string): GitHubSlug | null {
  const trimmed = raw
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')

  const scp = trimmed.match(/^[^@]+@github\.com:([^/]+)\/([^/]+)$/i)
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return { owner: scp[1], repo: scp[2] }
  }

  const url = trimmed.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/i)
  if (url?.[1] !== undefined && url[2] !== undefined) {
    return { owner: url[1], repo: url[2] }
  }

  return null
}

export function parseSlug(value: string): GitHubSlug | null {
  const match = value.trim().match(/^([^/\s]+)\/([^/\s]+)$/)
  if (match?.[1] === undefined || match[2] === undefined) {
    return null
  }
  return { owner: match[1], repo: match[2] }
}

function slugsEqual(a: GitHubSlug, b: GitHubSlug): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target)
  } catch {
    return null
  }
}

/**
 * DESIGN.md「固定検証順」の 1〜8 に対応する。
 * standard layout = absolute git dir が <root>/.git かつ core.hooksPath 未設定。
 * origin の raw URL は返却・保持しない。
 */
export async function inspectRepository(
  inputPath: string,
  expectedRepo: string,
): Promise<RepositoryInspection> {
  const inputReal = await realpathOrNull(inputPath)
  if (inputReal === null) {
    return { ok: false, code: 'NOT_GIT_ROOT' }
  }

  const topLevel = await git(['-C', inputReal, 'rev-parse', '--show-toplevel'])
  if (topLevel.code !== 0) {
    return { ok: false, code: 'NOT_GIT_ROOT' }
  }
  const rootReal = await realpathOrNull(topLevel.stdout.trim())
  if (rootReal === null || rootReal !== inputReal) {
    return { ok: false, code: 'NOT_GIT_ROOT' }
  }

  const gitDirOut = await git(['-C', inputReal, 'rev-parse', '--absolute-git-dir'])
  if (gitDirOut.code !== 0) {
    return { ok: false, code: 'GIT_LAYOUT_UNSUPPORTED' }
  }
  const gitDirReal = await realpathOrNull(gitDirOut.stdout.trim())
  const expectedGitDir = await realpathOrNull(join(rootReal, '.git'))
  if (gitDirReal === null || expectedGitDir === null || gitDirReal !== expectedGitDir) {
    return { ok: false, code: 'GIT_LAYOUT_UNSUPPORTED' }
  }

  const hooksPath = await git(['-C', inputReal, 'config', '--get', 'core.hooksPath'])
  if (hooksPath.code === 0 && hooksPath.stdout.trim() !== '') {
    return { ok: false, code: 'CUSTOM_HOOKS_PATH_UNSUPPORTED' }
  }

  const originOut = await git(['-C', inputReal, 'remote', 'get-url', 'origin'])
  const origin = originOut.code === 0 ? normalizeGitHubOrigin(originOut.stdout.trim()) : null
  const expected = parseSlug(expectedRepo)
  if (origin === null || expected === null || !slugsEqual(origin, expected)) {
    return { ok: false, code: 'REPOSITORY_MISMATCH' }
  }

  const headOut = await git(['-C', inputReal, 'rev-parse', 'HEAD'])
  const headSha = headOut.code === 0 ? headOut.stdout.trim() : ''

  return { ok: true, layout: { root: rootReal, gitDir: gitDirReal, origin, headSha } }
}

export async function getCommit(root: string, ref: string): Promise<CommitMetadata | null> {
  const out = await git(['-C', root, 'show', '-s', '--format=%H%x00%P%x00%aI%x00%B', ref])
  if (out.code !== 0) {
    return null
  }
  const [shaPart, parentPart, datePart, bodyPart] = out.stdout.split('\0')
  const sha = (shaPart ?? '').trim()
  if (sha === '') {
    return null
  }
  const parents = (parentPart ?? '').trim()
  const authoredRaw = (datePart ?? '').trim()
  return {
    sha,
    parentSha: parents === '' ? null : (parents.split(/\s+/)[0] ?? null),
    message: (bodyPart ?? '').replace(/\n$/, ''),
    authoredAt: authoredRaw === '' ? '' : new Date(authoredRaw).toISOString(),
  }
}

export function getHeadCommit(root: string): Promise<CommitMetadata | null> {
  return getCommit(root, 'HEAD')
}

/** DESIGN.md: patch 本文は最大 120,000 文字。超過時は末尾を切り truncated を立てる。 */
export const COMMIT_SHOW_MAX_CHARS = 120_000

export interface CommitShow {
  text: string
  truncated: boolean
}

export async function getCommitShow(root: string, sha: string): Promise<CommitShow | null> {
  const out = await git([
    '-C',
    root,
    'show',
    '--format=fuller',
    '--stat',
    '--patch',
    '--no-ext-diff',
    '--unified=3',
    sha,
  ])
  if (out.code !== 0) {
    return null
  }
  if (out.stdout.length > COMMIT_SHOW_MAX_CHARS) {
    return { text: out.stdout.slice(0, COMMIT_SHOW_MAX_CHARS), truncated: true }
  }
  return { text: out.stdout, truncated: false }
}

// --- v2: 自動登録用のローカル Git 操作 ------------------------------------

const GIT_PUSH_TIMEOUT_MS = 60_000

export interface LocalRepositoryState {
  /** Git 管理下なら working tree root (realpath)、そうでなければ null */
  root: string | null
  gitDir: string | null
  /** core.hooksPath が設定済みか */
  customHooksPath: boolean
  /** origin の raw URL 有無 */
  hasOrigin: boolean
  /** origin を GitHub slug へ正規化した結果。GitHub 以外は null */
  origin: GitHubSlug | null
  headSha: string | null
  branch: string | null
}

/** 承認済み candidate path の現況を 1 回で取る。expectedRepo を前提にしない点が inspectRepository と異なる。 */
export async function describeLocalRepository(path: string): Promise<LocalRepositoryState> {
  const empty: LocalRepositoryState = {
    root: null,
    gitDir: null,
    customHooksPath: false,
    hasOrigin: false,
    origin: null,
    headSha: null,
    branch: null,
  }
  const real = await realpathOrNull(path)
  if (real === null) {
    return empty
  }
  const topLevel = await git(['-C', real, 'rev-parse', '--show-toplevel'])
  if (topLevel.code !== 0) {
    return empty
  }
  const root = await realpathOrNull(topLevel.stdout.trim())
  if (root === null) {
    return empty
  }
  const gitDirOut = await git(['-C', root, 'rev-parse', '--absolute-git-dir'])
  const gitDir = gitDirOut.code === 0 ? await realpathOrNull(gitDirOut.stdout.trim()) : null
  const hooksPath = await git(['-C', root, 'config', '--get', 'core.hooksPath'])
  const originOut = await git(['-C', root, 'remote', 'get-url', 'origin'])
  const hasOrigin = originOut.code === 0 && originOut.stdout.trim() !== ''
  const headOut = await git(['-C', root, 'rev-parse', '--verify', 'HEAD'])
  // symbolic-ref は commit 0 件 (unborn HEAD) でも branch 名を返す。detached のときだけ失敗する。
  const branchOut = await git(['-C', root, 'symbolic-ref', '--short', 'HEAD'])
  const branch = branchOut.code === 0 ? branchOut.stdout.trim() : null

  return {
    root,
    gitDir,
    customHooksPath: hooksPath.code === 0 && hooksPath.stdout.trim() !== '',
    hasOrigin,
    origin: hasOrigin ? normalizeGitHubOrigin(originOut.stdout.trim()) : null,
    headSha: headOut.code === 0 ? headOut.stdout.trim() : null,
    branch: branch === null || branch === '' || branch === 'HEAD' ? null : branch,
  }
}

/** Git 外フォルダを既定 branch `main` で初期化する。 */
export async function initRepository(path: string): Promise<boolean> {
  const out = await git(['-C', path, 'init', '-b', 'main'])
  return out.code === 0
}

export async function setOrigin(root: string, url: string): Promise<boolean> {
  const out = await git(['-C', root, 'remote', 'add', 'origin', url])
  return out.code === 0
}

/** 新規 GitHub repository への初回 push。retry は registration 全体 retry へ委譲する。 */
export async function pushInitial(root: string, branch: string): Promise<boolean> {
  const out = await runProcess('git', ['-C', root, 'push', '-u', 'origin', branch], {
    timeoutMs: GIT_PUSH_TIMEOUT_MS,
  })
  return out.code === 0
}

/** push 後の readback。remote branch の SHA を取り直す。 */
export async function lsRemoteSha(root: string, branch: string): Promise<string | null> {
  const out = await git(['-C', root, 'ls-remote', 'origin', `refs/heads/${branch}`])
  if (out.code !== 0) {
    return null
  }
  const sha = out.stdout.trim().split(/\s+/)[0] ?? ''
  return sha === '' ? null : sha
}
