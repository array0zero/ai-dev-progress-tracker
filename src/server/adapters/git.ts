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
