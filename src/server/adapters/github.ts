import { z } from 'zod'
import { type RunResult, runProcess } from './process-runner.js'

const GH_TIMEOUT_MS = 20_000
const BODY_CAP = 8_000
const LIST_LIMIT = 20

export type GitHubErrorCode = 'GITHUB_CLI_ERROR'

export interface RepoView {
  id: string
  nameWithOwner: string
  url: string
  visibility: string
  defaultBranch: string | null
  /** v2: summary の第一候補。無ければ空文字。 */
  description: string
}

export interface IssueRecord {
  number: number
  title: string
  state: string
  body: string
  updatedAt: string
  url: string
  labels: string[]
}

export interface PullRequestRecord {
  number: number
  title: string
  state: string
  body: string
  updatedAt: string
  mergedAt: string | null
  url: string
  headRefName: string
  baseRefName: string
}

export type RepoViewResult = { ok: true; repo: RepoView } | { ok: false; code: GitHubErrorCode }

const repoViewSchema = z.object({
  id: z.string(),
  nameWithOwner: z.string(),
  url: z.string(),
  visibility: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
  description: z.string().nullable().default(null),
})

const issueListSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    body: z.string(),
    updatedAt: z.string(),
    url: z.string(),
    labels: z.array(z.object({ name: z.string() })).default([]),
  }),
)

const prListSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    body: z.string(),
    updatedAt: z.string(),
    mergedAt: z.string().nullable(),
    url: z.string(),
    headRefName: z.string(),
    baseRefName: z.string(),
  }),
)

const argsPrefixSchema = z.array(z.string())

interface GhInvoker {
  bin: string
  prefixArgs: string[]
}

/**
 * 既定は PATH 上の `gh`。テストは TRACKER_GH_BIN / TRACKER_GH_ARGS で
 * fake 実行体 (`node <fake-gh.mjs>`) を注入する。実 gh を CI から呼ばないための seam。
 */
function resolveGh(): GhInvoker {
  const bin = process.env.TRACKER_GH_BIN
  if (bin === undefined || bin === '') {
    return { bin: 'gh', prefixArgs: [] }
  }
  const rawArgs = process.env.TRACKER_GH_ARGS
  const prefixArgs =
    rawArgs === undefined || rawArgs === '' ? [] : argsPrefixSchema.parse(JSON.parse(rawArgs))
  return { bin, prefixArgs }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function byUpdatedAtDesc(a: { updatedAt: string }, b: { updatedAt: string }): number {
  if (a.updatedAt < b.updatedAt) {
    return 1
  }
  if (a.updatedAt > b.updatedAt) {
    return -1
  }
  return 0
}

const GH_READ_RETRY_DELAY_MS = 1_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runGhOnce(args: readonly string[]): Promise<RunResult | null> {
  const gh = resolveGh()
  try {
    return await runProcess(gh.bin, [...gh.prefixArgs, ...args], { timeoutMs: GH_TIMEOUT_MS })
  } catch {
    return null
  }
}

/** DESIGN.md: gh read は 1 回・1 秒後に再試行する。 */
async function runGhRead(args: readonly string[]): Promise<RunResult | null> {
  const first = await runGhOnce(args)
  if (first !== null && !first.timedOut && first.code === 0) {
    return first
  }
  await sleep(GH_READ_RETRY_DELAY_MS)
  return runGhOnce(args)
}

/** `gh auth status --active --hostname github.com` が exit 0 か。raw 出力は保持しない。 */
export async function checkAuth(): Promise<boolean> {
  const result = await runGhOnce(['auth', 'status', '--active', '--hostname', 'github.com'])
  return result !== null && !result.timedOut && result.code === 0
}

/** active な gh login の user login (owner) を返す。token は取得しない。 */
export async function getActiveLogin(): Promise<string | null> {
  const result = await runGhRead(['api', 'user', '--jq', '.login'])
  if (result === null || result.timedOut || result.code !== 0) {
    return null
  }
  const login = result.stdout.trim()
  return /^[A-Za-z0-9-]+$/.test(login) ? login : null
}

/** backup 用 Private repository を作成する。 */
export async function createPrivateRepo(slug: string): Promise<boolean> {
  const result = await runGhOnce(['repo', 'create', slug, '--private', '--disable-wiki'])
  return result !== null && !result.timedOut && result.code === 0
}

/**
 * 自動登録用: 対象 folder を source にして Private repository を作り origin を張る。
 * 失敗時の retry は registration 全体 retry へ委譲するのでここでは再試行しない。
 */
export async function createPrivateRepoFromSource(slug: string, path: string): Promise<boolean> {
  const result = await runGhOnce([
    'repo',
    'create',
    slug,
    '--private',
    '--source',
    path,
    '--remote',
    'origin',
  ])
  return result !== null && !result.timedOut && result.code === 0
}

/** `gh auth setup-git` を実行する (backup clone/push が gh 認証を使うため)。 */
export async function ensureAuthSetupGit(): Promise<boolean> {
  const result = await runGhOnce(['auth', 'setup-git'])
  return result !== null && !result.timedOut && result.code === 0
}

export async function viewRepo(slug: string): Promise<RepoViewResult> {
  const result = await runGhRead([
    'repo',
    'view',
    slug,
    '--json',
    'id,nameWithOwner,url,visibility,defaultBranchRef,description',
  ])
  if (result === null || result.timedOut || result.code !== 0) {
    return { ok: false, code: 'GITHUB_CLI_ERROR' }
  }
  const parsed = repoViewSchema.safeParse(safeJsonParse(result.stdout))
  if (!parsed.success) {
    return { ok: false, code: 'GITHUB_CLI_ERROR' }
  }
  return {
    ok: true,
    repo: {
      id: parsed.data.id,
      nameWithOwner: parsed.data.nameWithOwner,
      url: parsed.data.url,
      visibility: parsed.data.visibility,
      defaultBranch: parsed.data.defaultBranchRef?.name ?? null,
      description: parsed.data.description ?? '',
    },
  }
}

export async function listIssues(slug: string): Promise<IssueRecord[]> {
  const result = await runGhRead([
    'issue',
    'list',
    '-R',
    slug,
    '--state',
    'all',
    '--limit',
    String(LIST_LIMIT),
    '--json',
    'number,title,state,body,updatedAt,url,labels',
  ])
  if (result === null || result.timedOut || result.code !== 0) {
    return []
  }
  const parsed = issueListSchema.safeParse(safeJsonParse(result.stdout))
  if (!parsed.success) {
    return []
  }
  return parsed.data
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      body: issue.body.slice(0, BODY_CAP),
      updatedAt: issue.updatedAt,
      url: issue.url,
      labels: issue.labels.map((label) => label.name),
    }))
    .sort(byUpdatedAtDesc)
}

export async function listPullRequests(slug: string): Promise<PullRequestRecord[]> {
  const result = await runGhRead([
    'pr',
    'list',
    '-R',
    slug,
    '--state',
    'all',
    '--limit',
    String(LIST_LIMIT),
    '--json',
    'number,title,state,body,updatedAt,mergedAt,url,headRefName,baseRefName',
  ])
  if (result === null || result.timedOut || result.code !== 0) {
    return []
  }
  const parsed = prListSchema.safeParse(safeJsonParse(result.stdout))
  if (!parsed.success) {
    return []
  }
  return parsed.data
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      body: pr.body.slice(0, BODY_CAP),
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
    }))
    .sort(byUpdatedAtDesc)
}
