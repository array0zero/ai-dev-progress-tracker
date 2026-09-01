/**
 * live Codex 用 generation 評価 harness。CI では実行しない。
 *
 * 使い方:
 *   tsx scripts/eval-generation.ts --repo <absolute-git-root> [--cases <path>] [--out <path>]
 *
 * fixture の各ケースについて file 変更 -> commit -> generation run terminal 待機を行い、
 * DESIGN.md「必須評価fixture」の 5 規則で pass/fail を判定する。
 * 各 run の started_at - detected_at <= 60 秒も判定する。
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { openDatabase } from '../src/server/db/connection.js'
import { getLatestSnapshotByProject } from '../src/server/db/progress-repository.js'
import { insertProject } from '../src/server/db/project-repository.js'
import { getRunById, upsertCommit } from '../src/server/db/run-repository.js'
import { enqueueGeneration, generationScope } from '../src/server/services/generation-service.js'
import { processGenerationQueue } from '../src/worker/generation-worker.js'

const LATENCY_LIMIT_SECONDS = 60

interface FieldExpectation {
  status: 'confirmed' | 'needs_input'
  mustContain: string[]
  mustNotContain: string[]
  requiredEvidenceExternalKeys: string[]
}

interface GenerationCase {
  id: string
  commitMessage: string
  files: Array<{ path: string; content: string }>
  expected: Record<string, FieldExpectation>
}

interface CaseResult {
  id: string
  pass: boolean
  reasons: string[]
  runStatus: string | null
  errorCode: string | null
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

function fieldEvidenceExternalKeys(field: unknown, idToKey: Map<string, string>): Set<string> {
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
  return new Set(ids.map((id) => idToKey.get(id) ?? id))
}

function parseCliArgs(): { repo: string; casesPath: string; outPath: string | null } {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      cases: { type: 'string' },
      out: { type: 'string' },
    },
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

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
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
): boolean {
  const status = fieldStatus(field)
  if (status !== expectation.status) {
    reasons.push(`${key}: status ${status ?? 'missing'} != expected ${expectation.status}`)
    return false
  }
  const text = normalize(fieldText(field))
  let ok = true
  for (const needle of expectation.mustContain) {
    if (!text.includes(normalize(needle))) {
      reasons.push(`${key}: missing mustContain "${needle}"`)
      ok = false
    }
  }
  for (const needle of expectation.mustNotContain) {
    if (text.includes(normalize(needle))) {
      reasons.push(`${key}: contains mustNotContain "${needle}"`)
      ok = false
    }
  }
  const referenced = new Set(
    [...fieldEvidenceExternalKeys(field, idToKey)].map((k) => (k === commitSha ? '<commit>' : k)),
  )
  for (const required of expectation.requiredEvidenceExternalKeys) {
    if (!referenced.has(required)) {
      reasons.push(`${key}: required evidence key ${required} not referenced`)
      ok = false
    }
  }
  return ok
}

async function runCase(
  db: ReturnType<typeof openDatabase>,
  repo: string,
  projectId: string,
  testCase: GenerationCase,
): Promise<CaseResult> {
  for (const file of testCase.files) {
    const target = join(repo, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
  }
  git(repo, 'add', '-A')
  git(
    repo,
    '-c',
    'user.email=eval@example.com',
    '-c',
    'user.name=eval',
    'commit',
    '-m',
    testCase.commitMessage,
    '--allow-empty',
  )
  const sha = git(repo, 'rev-parse', 'HEAD')
  const parentSha = git(repo, 'rev-parse', 'HEAD~1')
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

  if (run === null || run.status === 'failed') {
    reasons.push(`run failed: ${run?.errorCode ?? 'unknown'}`)
    return {
      id: testCase.id,
      pass: false,
      reasons,
      runStatus: run?.status ?? null,
      errorCode: run?.errorCode ?? null,
      startLatencySeconds: latencySeconds,
      startLatencyWithinLimit: latencyOk,
    }
  }

  const snapshot = getLatestSnapshotByProject(db, projectId)
  let fieldsOk = true
  if (snapshot === null || snapshot.commitSha !== sha) {
    reasons.push('no snapshot for this commit')
    fieldsOk = false
  } else {
    const idToKey = evidenceKeyMap(db, projectId)
    const fields: Record<string, unknown> = {
      currentPosition: snapshot.currentPosition,
      completedItems: snapshot.completedItems,
      nextActions: snapshot.nextActions,
      importantDecisions: snapshot.decisions,
    }
    for (const [key, expectation] of Object.entries(testCase.expected)) {
      if (!judgeField(key, expectation, fields[key], idToKey, sha, reasons)) {
        fieldsOk = false
      }
    }
  }

  return {
    id: testCase.id,
    pass: fieldsOk && latencyOk,
    reasons,
    runStatus: run.status,
    errorCode: run.errorCode,
    startLatencySeconds: latencySeconds,
    startLatencyWithinLimit: latencyOk,
  }
}

async function main(): Promise<void> {
  const { repo, casesPath, outPath } = parseCliArgs()
  const { owner, name } = repoSlug(repo)
  const parsed = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases: GenerationCase[] }

  const db = openDatabase(join(repo, '.git', 'adpt-eval-generation.db'))
  const projectId = randomUUID()
  insertProject(db, {
    id: projectId,
    name: `eval:${owner}/${name}`,
    localPath: repo,
    repoNodeId: `EVAL_${randomUUID()}`,
    repoOwner: owner,
    repoName: name,
    repoUrl: `https://github.com/${owner}/${name}`,
    defaultBranch: 'main',
    status: 'active',
  })

  const results: CaseResult[] = []
  for (const testCase of parsed.cases) {
    results.push(await runCase(db, repo, projectId, testCase))
  }
  db.close()

  const passed = results.filter((r) => r.pass).length
  const latencyWithinLimit = results.filter((r) => r.startLatencyWithinLimit).length
  const json = JSON.stringify(
    {
      tool: 'eval:generation',
      repo,
      total: results.length,
      passed,
      failed: results.length - passed,
      startLatencyWithinLimit: latencyWithinLimit,
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
