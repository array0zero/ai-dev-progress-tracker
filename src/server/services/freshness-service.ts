import { getHeadCommit } from '../adapters/git.js'
import type { Db } from '../db/connection.js'
import { getLatestProgress, type SnapshotView } from '../db/progress-repository.js'
import { type ProjectRecord, updateProjectStatus } from '../db/project-repository.js'
import { getCommitRecord, getLatestCommit, upsertCommit } from '../db/run-repository.js'

/** DESIGN「派生値」の snapshot なし fallback。 */
export const WAITING_FOR_FIRST_COMMIT = '初回コミット待ち'
export const WAITING_FOR_GENERATION = '進捗生成待ち'

/** local HEAD 取得の並列上限 (DESIGN: 最大 4 parallel)。 */
export const HEAD_LOOKUP_CONCURRENCY = 4

export interface Freshness {
  /** 採用できる snapshot があるか。無いときだけ current の固定 fallback を使う。 */
  hasSnapshot: boolean
  latestCommitSha: string | null
  lastGeneratedCommitSha: string | null
  lastGeneratedAt: string | null
  unreflected: boolean
  hasNextAction: boolean
  lastUpdatedAt: string
  currentPosition: string | null
  status: ProjectRecord['status']
}

function maxIso(values: ReadonlyArray<string | null>): string {
  let max = ''
  for (const value of values) {
    if (value !== null && value > max) {
      max = value
    }
  }
  return max
}

/** DESIGN の `unreflected` 定義。derived 値なので DB へは保存しない (D011/D021)。 */
export function isUnreflected(
  latestCommitSha: string | null,
  lastGeneratedCommitSha: string | null,
): boolean {
  if (latestCommitSha === null) {
    return false
  }
  return lastGeneratedCommitSha === null || lastGeneratedCommitSha !== latestCommitSha
}

export function hasNextAction(view: SnapshotView | null): boolean {
  return (
    view !== null && view.nextActions.status === 'confirmed' && view.nextActions.items.length > 0
  )
}

export function fallbackCurrentPosition(latestCommitSha: string | null): string {
  return latestCommitSha === null ? WAITING_FOR_FIRST_COMMIT : WAITING_FOR_GENERATION
}

/**
 * local HEAD と最新 snapshot から鮮度を組み立てる。
 * 未登録の HEAD commit は metadata を DB へ upsert し、再 GET で同じ値が返るようにする。
 */
export function computeFreshness(
  db: Db,
  project: ProjectRecord,
  head: { sha: string; parentSha: string | null; message: string; authoredAt: string } | null,
  localMissing: boolean,
  now: Date = new Date(),
): Freshness {
  const iso = now.toISOString()
  if (head !== null && head.sha !== '' && getCommitRecord(db, project.id, head.sha) === null) {
    upsertCommit(db, {
      projectId: project.id,
      sha: head.sha,
      parentSha: head.parentSha,
      message: head.message,
      authoredAt: head.authoredAt !== '' ? head.authoredAt : iso,
      detectedAt: iso,
    })
  }

  const latestCommit = getLatestCommit(db, project.id)
  const latestCommitSha = head?.sha ?? latestCommit?.sha ?? null
  const progress = getLatestProgress(db, project.id)
  const view = progress?.view ?? null

  const lastGeneratedCommitSha = progress?.snapshot.commitSha ?? null
  const lastGeneratedAt = progress?.snapshot.createdAt ?? null

  return {
    hasSnapshot: view !== null,
    latestCommitSha,
    lastGeneratedCommitSha,
    lastGeneratedAt,
    unreflected: isUnreflected(latestCommitSha, lastGeneratedCommitSha),
    hasNextAction: hasNextAction(view),
    // backup 時刻は含めない (D013)。
    lastUpdatedAt: maxIso([
      project.updatedAt,
      latestCommit?.detectedAt ?? null,
      lastGeneratedAt,
      project.reviewRequiredAt,
    ]),
    // snapshot がある場合の needs_input は v1 どおり null のままにする (UI が「要補完」を出す)。
    currentPosition:
      view === null
        ? fallbackCurrentPosition(latestCommitSha)
        : view.currentPosition.status === 'needs_input'
          ? null
          : view.currentPosition.text,
    status: localMissing ? 'local_missing' : project.status,
  }
}

/** 最大 4 並列で local HEAD を取り直す。存在しない local path は HEAD なしになる。 */
export async function readHeads(
  projects: ReadonlyArray<Pick<ProjectRecord, 'id' | 'localPath'>>,
  concurrency = HEAD_LOOKUP_CONCURRENCY,
): Promise<Map<string, Awaited<ReturnType<typeof getHeadCommit>>>> {
  const heads = new Map<string, Awaited<ReturnType<typeof getHeadCommit>>>()
  const queue = [...projects]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const project = queue.shift()
      if (project === undefined) {
        return
      }
      heads.set(project.id, await getHeadCommit(project.localPath))
    }
  })
  await Promise.all(workers)
  return heads
}

/** local path が消えた project を local_missing にし、行は保持する。 */
export function syncLocalMissing(db: Db, project: ProjectRecord, exists: boolean): boolean {
  const localMissing = !exists
  const next = localMissing ? 'local_missing' : 'active'
  if (project.status !== next) {
    updateProjectStatus(db, project.id, next)
  }
  return localMissing
}
