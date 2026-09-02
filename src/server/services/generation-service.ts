import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { checkCodexReady, runCodexGeneration } from '../adapters/codex.js'
import { getCommitShow } from '../adapters/git.js'
import { listIssues, listPullRequests } from '../adapters/github.js'
import type { Db } from '../db/connection.js'
import { LEASE_STALE_MS, releaseLease } from '../db/lease-repository.js'
import {
  type EvidenceKind,
  getLatestSnapshotByProject,
  insertSnapshot,
  linkRunEvidence,
  type NewEvidence,
  upsertEvidence,
} from '../db/progress-repository.js'
import { getProjectById } from '../db/project-repository.js'
import {
  failRunningGenerationRuns,
  findRunByDedupeKey,
  type GenerationRunMode,
  type GenerationRunRecord,
  type GenerationRunTrigger,
  getCommitRecord,
  insertRun,
  markRunFailed,
  markRunTerminal,
  recordCodexCliVersion,
} from '../db/run-repository.js'
import {
  classifyByConfirmedCount,
  type ProgressOutput,
  type RecoveryClassification,
  validateProgressOutput,
} from '../schemas/progress.js'
import { redactHighConfidenceSecrets } from '../security/redaction.js'

export interface EnqueueGenerationParams {
  projectId: string
  sha: string
  mode: GenerationRunMode
  trigger: GenerationRunTrigger
  /** 既定は `generation:<project>:<sha>`。recovery は重複しない key を渡す。 */
  dedupeKey?: string
}

export interface EnqueueGenerationResult {
  runId: string
  created: boolean
  shouldSpawn: boolean
  scope: string
  ownerToken: string | null
}

export function generationScope(projectId: string): string {
  return `generation:${projectId}`
}

export function generationDedupeKey(projectId: string, sha: string): string {
  return `generation:${projectId}:${sha}`
}

/**
 * commit 単位で generation run を 1 件だけ queue し、同一 transaction 内で
 * `generation:<project-id>` lease を取得する。取得できた呼び出し元だけ `shouldSpawn=true`。
 */
export function enqueueGeneration(
  db: Db,
  params: EnqueueGenerationParams,
  now: () => Date = () => new Date(),
): EnqueueGenerationResult {
  const scope = generationScope(params.projectId)
  const dedupeKey = params.dedupeKey ?? generationDedupeKey(params.projectId, params.sha)
  const ownerToken = randomUUID()

  const enqueue = db.transaction((): EnqueueGenerationResult => {
    const current = now()

    // stale lease は running run を WORKER_LEASE_EXPIRED にしてから削除する。
    const staleBefore = new Date(current.getTime() - LEASE_STALE_MS).toISOString()
    const stale = db
      .prepare('SELECT 1 FROM worker_leases WHERE scope = ? AND heartbeat_at < ?')
      .get(scope, staleBefore)
    if (stale !== undefined) {
      failRunningGenerationRuns(db, params.projectId, 'WORKER_LEASE_EXPIRED', current)
      db.prepare('DELETE FROM worker_leases WHERE scope = ?').run(scope)
    }

    const existing = findRunByDedupeKey(db, dedupeKey)
    let runId: string
    let created: boolean
    if (existing !== null) {
      runId = existing.id
      created = false
    } else {
      runId = randomUUID()
      insertRun(db, {
        id: runId,
        dedupeKey,
        projectId: params.projectId,
        commitSha: params.sha,
        mode: params.mode,
        trigger: params.trigger,
        detectedAt: current.toISOString(),
      })
      created = true
    }

    const held = db.prepare('SELECT 1 FROM worker_leases WHERE scope = ?').get(scope)
    if (held !== undefined) {
      return { runId, created, shouldSpawn: false, scope, ownerToken: null }
    }
    db.prepare('INSERT INTO worker_leases (scope, owner_token, heartbeat_at) VALUES (?, ?, ?)').run(
      scope,
      ownerToken,
      current.toISOString(),
    )
    return { runId, created, shouldSpawn: true, scope, ownerToken }
  })

  return enqueue()
}

export interface SpawnWorkerDeps {
  /** テスト用 seam。実行体を差し替える。 */
  spawnWorker?: (scope: string, ownerToken: string) => void
}

function workerEntryPath(): string {
  // dist/server/services/generation-service.js -> dist/worker/index.js
  return fileURLToPath(new URL('../../worker/index.js', import.meta.url))
}

function defaultSpawnWorker(scope: string, ownerToken: string): void {
  const child = spawn(
    process.execPath,
    [workerEntryPath(), '--scope', scope, '--token', ownerToken],
    { detached: true, stdio: 'ignore' },
  )
  // 起点プロセス終了で DB 接続は閉じるため、非同期 spawn error はここで回収しない
  // (次回 enqueue の 180 秒 stale 判定で lease を回収する)。
  child.on('error', () => undefined)
  child.unref()
}

function onSpawnFailure(db: Db, scope: string, ownerToken: string, originRunId: string): void {
  releaseLease(db, scope, ownerToken)
  markRunFailed(db, originRunId, 'WORKER_SPAWN_FAILED', 'Failed to start the generation worker.')
}

/** detached generation worker を起動する。同期的な spawn 失敗時は lease を戻し起点 run を failed にする。 */
export function startGenerationWorker(
  db: Db,
  scope: string,
  ownerToken: string,
  originRunId: string,
  deps: SpawnWorkerDeps = {},
): void {
  const doSpawn = deps.spawnWorker ?? defaultSpawnWorker
  try {
    doSpawn(scope, ownerToken)
  } catch {
    onSpawnFailure(db, scope, ownerToken, originRunId)
  }
}

export interface EvidenceBundleItem {
  id: string
  kind: EvidenceKind
  externalKey: string
  sourceVersion: string
  title: string
  url: string | null
  payload: unknown
}

export interface EvidenceBundle {
  runId: string
  commitSha: string
  evidence: EvidenceBundleItem[]
  /** 生成 context 用。evidence ID としては扱わない。 */
  latestSnapshotContext: unknown
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 200 ? line.slice(0, 200) : line
}

/**
 * DESIGN.md「evidence収集範囲」。対象 project の 1 リポジトリだけから
 * commit / Issue(20) / PR(20) を集め、保存前に high-confidence scanner を通し、
 * evidence を upsert して run_evidence へ紐付ける。最新 snapshot は context のみ。
 */
export async function collectEvidenceBundle(
  db: Db,
  run: GenerationRunRecord,
  now: () => Date = () => new Date(),
): Promise<EvidenceBundle> {
  const project = getProjectById(db, run.projectId)
  if (project === null) {
    throw new Error(`project ${run.projectId} not found`)
  }
  const slug = `${project.repoOwner}/${project.repoName}`
  const capturedAt = now().toISOString()

  const drafts: Array<Omit<EvidenceBundleItem, 'id'>> = []

  const commit = getCommitRecord(db, run.projectId, run.commitSha)
  if (commit !== null) {
    const show = await getCommitShow(project.localPath, run.commitSha)
    // redaction は長さ切り詰めより前。getCommitShow の 120,000 上限適用後に scanner を通す。
    const message = redactHighConfidenceSecrets(commit.message)
    const patch = show === null ? '' : redactHighConfidenceSecrets(show.text)
    drafts.push({
      kind: 'commit',
      externalKey: run.commitSha,
      sourceVersion: run.commitSha,
      title: firstLine(message),
      url: null,
      payload: {
        sha: run.commitSha,
        parentSha: commit.parentSha,
        authoredAt: commit.authoredAt,
        message,
        patch,
        truncated: show?.truncated ?? false,
      },
    })
  }

  for (const issue of await listIssues(slug)) {
    const title = redactHighConfidenceSecrets(issue.title)
    drafts.push({
      kind: 'issue',
      externalKey: String(issue.number),
      sourceVersion: issue.updatedAt,
      title,
      url: issue.url,
      payload: {
        number: issue.number,
        state: issue.state,
        title,
        body: redactHighConfidenceSecrets(issue.body),
        updatedAt: issue.updatedAt,
        labels: issue.labels,
      },
    })
  }

  for (const pr of await listPullRequests(slug)) {
    const title = redactHighConfidenceSecrets(pr.title)
    drafts.push({
      kind: 'pull_request',
      externalKey: String(pr.number),
      sourceVersion: pr.updatedAt,
      title,
      url: pr.url,
      payload: {
        number: pr.number,
        state: pr.state,
        title,
        body: redactHighConfidenceSecrets(pr.body),
        updatedAt: pr.updatedAt,
        mergedAt: pr.mergedAt,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
      },
    })
  }

  const evidence: EvidenceBundleItem[] = drafts.map((draft) => {
    const newEvidence: NewEvidence = {
      projectId: run.projectId,
      kind: draft.kind,
      externalKey: draft.externalKey,
      sourceVersion: draft.sourceVersion,
      title: draft.title,
      url: draft.url,
      payload: draft.payload,
      capturedAt,
    }
    return { ...draft, id: upsertEvidence(db, newEvidence) }
  })

  linkRunEvidence(
    db,
    run.id,
    evidence.map((item) => item.id),
  )

  const latestSnapshot = getLatestSnapshotByProject(db, run.projectId)

  return {
    runId: run.id,
    commitSha: run.commitSha,
    evidence,
    latestSnapshotContext:
      latestSnapshot === null
        ? null
        : {
            recoveryStatus: latestSnapshot.recoveryStatus,
            currentPosition: latestSnapshot.currentPosition,
            completedItems: latestSnapshot.completedItems,
            nextActions: latestSnapshot.nextActions,
            decisions: latestSnapshot.decisions,
          },
  }
}

const PROMPT_CONTRACT = `あなたは開発進捗抽出器です。
入力のevidence以外の知識・推測を使わないでください。
4フィールド currentPosition / completedItems / nextActions / importantDecisions を返してください。

confirmed の条件:
- evidence本文に明記された事実だけを confirmed にできます。
- Issue/PRのタイトルだけ、本文が空・曖昧・一語、依存更新やlockfileやフォーマット等のroutine変更しか無い場合は、その事実からプロジェクトの進捗は判断できません。confirmed にせず needs_input にしてください。
- 推測・要約・言い換えによる穴埋めは禁止です。

needs_input の固定形式 (説明文やevidenceIdを入れない):
- currentPosition: {"status":"needs_input","text":"要補完","evidenceIds":[]}
- completedItems / nextActions / importantDecisions: {"status":"needs_input","items":[],"evidenceIds":[]}

evidence が全く役に立たない場合は、4フィールドすべてを上記 needs_input 形式で返してください。
どんな入力でも必ずJSON Schemaに完全一致する有効なJSONを返し、拒否や自由文で応答しないでください。
confirmed の field と item には、入力bundleに存在する evidenceId を1件以上付けてください。
判断事項(importantDecisions)の confirmed item には decision と rationale を含めてください。`

export function buildGenerationPrompt(bundle: EvidenceBundle): string {
  const payload = {
    commitSha: bundle.commitSha,
    evidence: bundle.evidence,
    latestSnapshot: bundle.latestSnapshotContext,
  }
  return `${PROMPT_CONTRACT}\n\n<evidence_bundle>\n${JSON.stringify(payload, null, 2)}\n</evidence_bundle>\n`
}

/**
 * generation 本体。
 * T009: evidence bundle 収集 / T010: Codex 実行 + 出力検証 / T011: snapshot 保存 + confirmed 数分類。
 * 現状は検証まで実装し、snapshot 永続化は T011。
 */
export async function runGeneration(db: Db, run: GenerationRunRecord): Promise<void> {
  const bundle = await collectEvidenceBundle(db, run)

  const ready = await checkCodexReady()
  if (!ready.ok) {
    markRunFailed(db, run.id, ready.code, `Codex is not ready (${ready.code}).`)
    return
  }

  const exec = await runCodexGeneration(buildGenerationPrompt(bundle))
  if (!exec.ok) {
    markRunFailed(db, run.id, exec.code, 'Codex execution did not produce a valid output.')
    return
  }

  const validation = validateProgressOutput(
    exec.output,
    new Set(bundle.evidence.map((item) => item.id)),
  )
  if (!validation.ok) {
    markRunFailed(db, run.id, validation.code, validation.reason.slice(0, 500))
    return
  }

  persistSnapshot(db, run, validation.progress, validation.confirmedCount, ready.version)
}

/** valid output を 1 transaction で snapshot 保存 + run を分類終端する。 */
export function persistSnapshot(
  db: Db,
  run: GenerationRunRecord,
  progress: ProgressOutput,
  confirmedCount: number,
  aiCliVersion: string | null,
  now: () => Date = () => new Date(),
): RecoveryClassification {
  const classification = classifyByConfirmedCount(confirmedCount)
  const timestamp = now()
  const save = db.transaction((): void => {
    if (aiCliVersion !== null) {
      recordCodexCliVersion(db, run.id, aiCliVersion)
    }
    insertSnapshot(
      db,
      {
        id: randomUUID(),
        generationRunId: run.id,
        projectId: run.projectId,
        commitSha: run.commitSha,
        recoveryStatus: classification.recoveryStatus,
        currentPosition: progress.currentPosition,
        completedItems: progress.completedItems,
        nextActions: progress.nextActions,
        decisions: progress.importantDecisions,
      },
      timestamp,
    )
    markRunTerminal(db, run.id, classification.runStatus, null, null, timestamp)
  })
  save()
  return classification
}
