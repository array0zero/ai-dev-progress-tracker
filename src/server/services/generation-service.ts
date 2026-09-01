import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getCommitShow } from '../adapters/git.js'
import { listIssues, listPullRequests } from '../adapters/github.js'
import type { Db } from '../db/connection.js'
import { LEASE_STALE_MS, releaseLease } from '../db/lease-repository.js'
import {
  type EvidenceKind,
  getLatestSnapshotByProject,
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
} from '../db/run-repository.js'
import { redactHighConfidenceSecrets } from '../security/redaction.js'

export interface EnqueueGenerationParams {
  projectId: string
  sha: string
  mode: GenerationRunMode
  trigger: GenerationRunTrigger
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
  const dedupeKey = generationDedupeKey(params.projectId, params.sha)
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

/**
 * generation 本体。T009 で evidence bundle 収集を実装。
 * T010 で Codex 実行、T011 で snapshot 保存 / confirmed 数分類 を追加する。
 * 現状は Codex 未配線のため bundle 収集後に failed(CODEX_UNAVAILABLE) で終端する。
 */
export async function runGeneration(db: Db, run: GenerationRunRecord): Promise<void> {
  await collectEvidenceBundle(db, run)
  markRunFailed(db, run.id, 'CODEX_UNAVAILABLE', 'Codex generation pipeline is not configured yet.')
}
