/**
 * live Codex 用 generation 評価 harness。CI では実行しない。
 *
 * 使い方:
 *   tsx scripts/eval-generation.ts --repo <absolute-git-root> [--cases <path>] [--out <path>]
 *
 * PLAN の成功指標「4 項目が根拠付きで生成される」を計測する。
 * fixture の各ケースについて file 変更 -> commit -> generation run terminal 待機を行い、
 * 4 フィールドが confirmed かつ根拠 (commit evidence) を伴うかで pass/fail を判定する。
 * 各 run の started_at - detected_at <= 60 秒も判定する。
 *
 * commit は呼び出し元の branch / working tree / index を汚さないよう、HEAD から切り出した
 * detached の `git worktree` 内でのみ行い、終了時に worktree ごと破棄する。
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { openDatabase } from '../src/server/db/connection.js'
import { getLatestSnapshotByProject } from '../src/server/db/progress-repository.js'
import { insertProject } from '../src/server/db/project-repository.js'
import { getRunById, upsertCommit } from '../src/server/db/run-repository.js'
import { enqueueGeneration, generationScope } from '../src/server/services/generation-service.js'
import { processGenerationQueue } from '../src/worker/generation-worker.js'

const LATENCY_LIMIT_SECONDS = 60
const FIELD_KEYS = [
  'currentPosition',
  'completedItems',
  'nextActions',
  'importantDecisions',
] as const
type FieldKey = (typeof FIELD_KEYS)[number]

interface FieldExpectation {
  status: 'confirmed' | 'needs_input'
  requiredEvidenceExternalKeys: string[]
  // substring 一致は自然言語生成の評価として脆いため補助扱い。空なら評価しない。
  mustContain?: string[]
  mustNotContain?: string[]
}

interface GenerationCase {
  id: string
  commitMessage: string
  files: Array<{ path: string; content: string }>
  expected: Record<FieldKey, FieldExpectation>
}

interface FieldResult {
  status: string | null
  evidenceExternalKeys: string[]
  /** confirmed かつ根拠 (evidence 参照) を 1 件以上持つ */
  solid: boolean
}

interface CaseResult {
  id: string
  pass: boolean
  reasons: string[]
  runStatus: string | null
  errorCode: string | null
  confirmedFields: number
  fields: Record<string, FieldResult>
  startLatencySeconds: number | null
  startLatencyWithinLimit: boolean
}

// DESIGN.md: Unicode NFKC 正規化後、英字だけ lowercase 化して substring 比較する。
function normalize(text: string): string {
  return text.normalize('NFKC').replace(/[A-Z]/g, (c) => c.toLowerCase())
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function fieldStatus(field: unknown): string | null {
  const record = asRecord(field)
  return typeof record?.status === 'string' ? record.status : null
}

function fieldText(field: unknown): string {
  const record = asRecord(field)
  if (record === null) {
    return ''
  }
  const parts: string[] = []
  if (typeof record.text === 'string') {
    parts.push(record.text)
  }
  if (Array.isArray(record.items)) {
    for (const item of record.items) {
      const itemRecord = asRecord(item)
      if (itemRecord === null) {
        continue
      }
      for (const value of [itemRecord.text, itemRecord.decision, itemRecord.rationale]) {
        if (typeof value === 'string') {
          parts.push(value)
        }
      }
    }
  }
  return parts.join('\n')
}

function fieldEvidenceIds(field: unknown): string[] {
  const record = asRecord(field)
  const ids: string[] = []
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const id of value) {
        if (typeof id === 'string') {
          ids.push(id)
        }
      }
    }
  }
  if (record !== null) {
    collect(record.evidenceIds)
    if (Array.isArray(record.items)) {
      for (const item of record.items) {
        collect(asRecord(item)?.evidenceIds)
      }
    }
  }
  return ids
}

function parseCliArgs(): { repo: string; casesPath: string; outPath: string | null } {
  const { values } = parseArgs({
    options: { repo: { type: 'string' }, cases: { type: 'string' }, out: { type: 'string' } },
    strict: false,
  })
  const repo = typeof values.repo === 'string' ? values.repo : ''
  if (repo === '' || !isAbsolute(repo)) {
    throw new Error('--repo <absolute-git-root> is required')
  }
  return {
    repo,
    casesPath:
      typeof values.cases === 'string'
        ? values.cases
        : join(process.cwd(), 'tests/fixtures/generation-cases.json'),
    outPath: typeof values.out === 'string' ? values.out : null,
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function repoSlug(repo: string): { owner: string; name: string } {
  const url = git(repo, 'remote', 'get-url', 'origin')
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`cannot parse owner/name from origin url: ${url}`)
  }
  return { owner: match[1], name: match[2] }
}

function evidenceKeyMap(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
): Map<string, string> {
  const rows = db
    .prepare('SELECT id, external_key FROM evidence WHERE project_id = ?')
    .all(projectId) as Array<{ id: string; external_key: string }>
  return new Map(rows.map((row) => [row.id, row.external_key]))
}

function judgeField(
  key: string,
  expectation: FieldExpectation,
  field: unknown,
  idToKey: Map<string, string>,
  commitSha: string,
  reasons: string[],
): FieldResult {
  const status = fieldStatus(field)
  const externalKeys = [
    ...new Set(
      fieldEvidenceIds(field).map((id) => {
        const k = idToKey.get(id) ?? id
        return k === commitSha ? '<commit>' : k
      }),
    ),
  ]
  const solid = status === 'confirmed' && externalKeys.length > 0
  const result: FieldResult = { status, evidenceExternalKeys: externalKeys, solid }

  if (status !== expectation.status) {
    reasons.push(`${key}: status ${status ?? 'missing'} != expected ${expectation.status}`)
  }
  if (expectation.status === 'confirmed') {
    for (const required of expectation.requiredEvidenceExternalKeys) {
      if (!externalKeys.includes(required)) {
        reasons.push(`${key}: required evidence key ${required} not referenced`)
      }
    }
  }
  const text = normalize(fieldText(field))
  for (const needle of expectation.mustContain ?? []) {
    if (!text.includes(normalize(needle))) {
      reasons.push(`${key}: missing mustContain "${needle}"`)
    }
  }
  for (const needle of expectation.mustNotContain ?? []) {
    if (text.includes(normalize(needle))) {
      reasons.push(`${key}: contains mustNotContain "${needle}"`)
    }
  }
  return result
}

async function runCase(
  db: ReturnType<typeof openDatabase>,
  worktree: string,
  projectId: string,
  testCase: GenerationCase,
): Promise<CaseResult> {
  for (const file of testCase.files) {
    const target = join(worktree, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
  }
  git(worktree, 'add', '-A')
  git(
    worktree,
    '-c',
    'user.email=eval@example.com',
    '-c',
    'user.name=eval',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    testCase.commitMessage,
    '--allow-empty',
  )
  const sha = git(worktree, 'rev-parse', 'HEAD')
  const parentSha = git(worktree, 'rev-parse', 'HEAD~1')
  const nowIso = new Date().toISOString()
  upsertCommit(db, {
    projectId,
    sha,
    parentSha,
    message: testCase.commitMessage,
    authoredAt: nowIso,
    detectedAt: nowIso,
  })

  const enqueued = enqueueGeneration(db, {
    projectId,
    sha,
    mode: 'generation',
    trigger: 'post_commit',
  })
  await processGenerationQueue(db, generationScope(projectId), enqueued.ownerToken ?? '')

  const run = getRunById(db, enqueued.runId)
  const reasons: string[] = []
  let latencySeconds: number | null = null
  let latencyOk = false
  if (run?.startedAt != null && run.detectedAt != null) {
    latencySeconds = (Date.parse(run.startedAt) - Date.parse(run.detectedAt)) / 1000
    latencyOk = latencySeconds <= LATENCY_LIMIT_SECONDS
    if (!latencyOk) {
      reasons.push(`start latency ${latencySeconds}s exceeds ${LATENCY_LIMIT_SECONDS}s`)
    }
  } else {
    reasons.push('run has no started_at')
  }

  const emptyFields: Record<string, FieldResult> = {}
  for (const key of FIELD_KEYS) {
    emptyFields[key] = { status: null, evidenceExternalKeys: [], solid: false }
  }

  if (run === null || run.status === 'failed') {
    reasons.push(`run failed: ${run?.errorCode ?? 'unknown'}`)
    return {
      id: testCase.id,
      pass: false,
      reasons,
      runStatus: run?.status ?? null,
      errorCode: run?.errorCode ?? null,
      confirmedFields: 0,
      fields: emptyFields,
      startLatencySeconds: latencySeconds,
      startLatencyWithinLimit: latencyOk,
    }
  }

  const snapshot = getLatestSnapshotByProject(db, projectId)
  const fields: Record<string, FieldResult> = { ...emptyFields }
  if (snapshot === null || snapshot.commitSha !== sha) {
    reasons.push('no snapshot for this commit')
  } else {
    const idToKey = evidenceKeyMap(db, projectId)
    const raw: Record<FieldKey, unknown> = {
      currentPosition: snapshot.currentPosition,
      completedItems: snapshot.completedItems,
      nextActions: snapshot.nextActions,
      importantDecisions: snapshot.decisions,
    }
    for (const key of FIELD_KEYS) {
      fields[key] = judgeField(key, testCase.expected[key], raw[key], idToKey, sha, reasons)
    }
  }

  const confirmedFields = Object.values(fields).filter((f) => f.solid).length
  return {
    id: testCase.id,
    pass: reasons.length === 0,
    reasons,
    runStatus: run.status,
    errorCode: run.errorCode,
    confirmedFields,
    fields,
    startLatencySeconds: latencySeconds,
    startLatencyWithinLimit: latencyOk,
  }
}

async function main(): Promise<void> {
  const { repo, casesPath, outPath } = parseCliArgs()
  const { owner, name } = repoSlug(repo)
  const parsed = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases: GenerationCase[] }

  let head: string
  try {
    head = git(repo, 'rev-parse', 'HEAD')
  } catch {
    throw new Error(`--repo has no commits: ${repo}`)
  }

  // 呼び出し元の branch / working tree / index に触れないよう worktree で隔離する。
  const worktreeParent = mkdtempSync(join(tmpdir(), 'adpt-eval-wt-'))
  const worktree = join(worktreeParent, 'wt')
  const dbDir = mkdtempSync(join(tmpdir(), 'adpt-eval-db-'))
  git(repo, 'worktree', 'add', '--detach', worktree, head)

  const results: CaseResult[] = []
  try {
    const db = openDatabase(join(dbDir, 'eval.db'))
    const projectId = randomUUID()
    insertProject(db, {
      id: projectId,
      name: `eval:${owner}/${name}`,
      localPath: worktree,
      repoNodeId: `EVAL_${randomUUID()}`,
      repoOwner: owner,
      repoName: name,
      repoUrl: `https://github.com/${owner}/${name}`,
      defaultBranch: 'main',
      status: 'active',
    })
    for (const testCase of parsed.cases) {
      results.push(await runCase(db, worktree, projectId, testCase))
    }
    db.close()
  } finally {
    try {
      git(repo, 'worktree', 'remove', '--force', worktree)
    } catch {
      // best effort
    }
    rmSync(worktreeParent, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  }

  const passed = results.filter((r) => r.pass).length
  const latencyWithinLimit = results.filter((r) => r.startLatencyWithinLimit).length
  const fieldConfirmed: Record<string, number> = {}
  for (const key of FIELD_KEYS) {
    fieldConfirmed[key] = results.filter((r) => r.fields[key]?.solid).length
  }
  const json = JSON.stringify(
    {
      tool: 'eval:generation',
      repo,
      total: results.length,
      passed,
      failed: results.length - passed,
      startLatencyWithinLimit: latencyWithinLimit,
      fieldConfirmedCounts: fieldConfirmed,
      cases: results,
    },
    null,
    2,
  )
  if (outPath !== null) {
    writeFileSync(outPath, `${json}\n`)
  }
  process.stdout.write(`${json}\n`)
  process.stderr.write(
    `eval:generation ${passed}/${results.length} passed, ${latencyWithinLimit}/${results.length} within ${LATENCY_LIMIT_SECONDS}s\n`,
  )
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
