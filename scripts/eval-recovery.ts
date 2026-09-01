/**
 * live Codex 用 recovery 評価 harness。CI では実行しない。
 *
 * 使い方:
 *   tsx scripts/eval-recovery.ts [--cases <path>] [--out <path>]
 *
 * fixture の各ケースの evidence から生成 prompt を組み、Codex 出力を
 * DESIGN.md「必須評価fixture」の 5 規則 + expectedRecoveryStatus で判定する。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { checkCodexReady, runCodexGeneration } from '../src/server/adapters/codex.js'
import { classifyByConfirmedCount, validateProgressOutput } from '../src/server/schemas/progress.js'
import {
  buildGenerationPrompt,
  type EvidenceBundle,
} from '../src/server/services/generation-service.js'

interface FieldExpectation {
  status: 'confirmed' | 'needs_input'
  mustContain: string[]
  mustNotContain: string[]
  requiredEvidenceExternalKeys: string[]
}

interface RecoveryCase {
  id: string
  expectedRecoveryStatus: 'complete' | 'partial' | 'unrecoverable'
  evidence: Array<{ kind: string; externalKey: string; title: string; body: string }>
  expected: Record<string, FieldExpectation>
}

interface CaseResult {
  id: string
  pass: boolean
  reasons: string[]
  recoveryStatus: string | null
}

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

function judgeField(
  key: string,
  expectation: FieldExpectation,
  field: unknown,
  idToKey: Map<string, string>,
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
  const referenced = fieldEvidenceExternalKeys(field, idToKey)
  for (const required of expectation.requiredEvidenceExternalKeys) {
    if (!referenced.has(required)) {
      reasons.push(`${key}: required evidence key ${required} not referenced`)
      ok = false
    }
  }
  return ok
}

function buildBundle(testCase: RecoveryCase): {
  bundle: EvidenceBundle
  idToKey: Map<string, string>
} {
  const idToKey = new Map<string, string>()
  const evidence = testCase.evidence.map((entry) => {
    const id = randomUUID()
    idToKey.set(id, entry.externalKey)
    return {
      id,
      kind: entry.kind as 'commit' | 'issue' | 'pull_request',
      externalKey: entry.externalKey,
      sourceVersion: entry.externalKey,
      title: entry.title,
      url: null,
      payload: { number: Number(entry.externalKey) || entry.externalKey, body: entry.body },
    }
  })
  return {
    bundle: {
      runId: randomUUID(),
      commitSha: '0'.repeat(40),
      evidence,
      latestSnapshotContext: null,
    },
    idToKey,
  }
}

async function runCase(testCase: RecoveryCase): Promise<CaseResult> {
  const reasons: string[] = []
  const { bundle, idToKey } = buildBundle(testCase)
  const exec = await runCodexGeneration(buildGenerationPrompt(bundle))
  if (!exec.ok) {
    return {
      id: testCase.id,
      pass: false,
      reasons: [`codex exec failed: ${exec.code}`],
      recoveryStatus: null,
    }
  }
  const validation = validateProgressOutput(exec.output, new Set(bundle.evidence.map((e) => e.id)))
  if (!validation.ok) {
    return {
      id: testCase.id,
      pass: false,
      reasons: [`invalid output: ${validation.code}`],
      recoveryStatus: null,
    }
  }
  const classification = classifyByConfirmedCount(validation.confirmedCount)
  if (classification.recoveryStatus !== testCase.expectedRecoveryStatus) {
    reasons.push(
      `recoveryStatus ${classification.recoveryStatus} != expected ${testCase.expectedRecoveryStatus}`,
    )
  }
  const fields: Record<string, unknown> = {
    currentPosition: validation.progress.currentPosition,
    completedItems: validation.progress.completedItems,
    nextActions: validation.progress.nextActions,
    importantDecisions: validation.progress.importantDecisions,
  }
  let ok = classification.recoveryStatus === testCase.expectedRecoveryStatus
  for (const [key, expectation] of Object.entries(testCase.expected)) {
    if (!judgeField(key, expectation, fields[key], idToKey, reasons)) {
      ok = false
    }
  }
  return { id: testCase.id, pass: ok, reasons, recoveryStatus: classification.recoveryStatus }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { cases: { type: 'string' }, out: { type: 'string' } },
    strict: false,
  })
  const casesPath =
    typeof values.cases === 'string'
      ? values.cases
      : join(process.cwd(), 'tests/fixtures/recovery-cases.json')
  const outPath = typeof values.out === 'string' ? values.out : null

  const ready = await checkCodexReady()
  if (!ready.ok) {
    throw new Error(`Codex is not ready: ${ready.code}`)
  }

  const parsed = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases: RecoveryCase[] }
  const results: CaseResult[] = []
  for (const testCase of parsed.cases) {
    results.push(await runCase(testCase))
  }

  const passed = results.filter((r) => r.pass).length
  const json = JSON.stringify(
    {
      tool: 'eval:recovery',
      total: results.length,
      passed,
      failed: results.length - passed,
      cases: results,
    },
    null,
    2,
  )
  if (outPath !== null) {
    writeFileSync(outPath, `${json}\n`)
  }
  process.stdout.write(`${json}\n`)
  process.stderr.write(`eval:recovery ${passed}/${results.length} passed\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
