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

async function runGh(args: readonly string[]): Promise<RunResult | null> {
  const gh = resolveGh()
  try {
    return await runProcess(gh.bin, [...gh.prefixArgs, ...args], { timeoutMs: GH_TIMEOUT_MS })
  } catch {
    return null
  }
}

/** `gh auth status --active --hostname github.com` が exit 0 か。raw 出力は保持しない。 */
export async function checkAuth(): Promise<boolean> {
  const result = await runGh(['auth', 'status', '--active', '--hostname', 'github.com'])
  return result !== null && !result.timedOut && result.code === 0
}

export async function viewRepo(slug: string): Promise<RepoViewResult> {
  const result = await runGh([
    'repo',
    'view',
    slug,
    '--json',
    'id,nameWithOwner,url,visibility,defaultBranchRef',
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
    },
  }
}

export async function listIssues(slug: string): Promise<IssueRecord[]> {
  const result = await runGh([
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
  const result = await runGh([
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
