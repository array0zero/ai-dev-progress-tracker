import { realpathSync } from 'node:fs'
import { getCommit } from '../../server/adapters/git.js'
import { loadConfig } from '../../server/config.js'
import { type Db, openDatabase } from '../../server/db/connection.js'
import { getProjectById } from '../../server/db/project-repository.js'
import { upsertCommit } from '../../server/db/run-repository.js'
import {
  enqueueGeneration,
  type SpawnWorkerDeps,
  startGenerationWorker,
} from '../../server/services/generation-service.js'

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i

export interface HookCommitArgs {
  projectId: string
  repo: string
  sha: string
}

export interface HookCommitDeps extends SpawnWorkerDeps {
  db?: Db
  now?: () => Date
}

/**
 * post-commit hook から呼ばれる。DB 登録前に project/repo/SHA を検証し、
 * commit を upsert して generation run を queue、必要なら worker を spawn して即座に返す。
 * 判定できない引数は静かに無視する (hook は出力を捨てるため)。
 */
export async function runHookCommit(
  args: HookCommitArgs,
  deps: HookCommitDeps = {},
): Promise<number> {
  const ownDb = deps.db === undefined
  const db = deps.db ?? openDatabase(loadConfig().dbPath)
  const now = deps.now ?? (() => new Date())
  try {
    const project = getProjectById(db, args.projectId)
    if (project === null) {
      return 0
    }

    let repoReal: string
    try {
      repoReal = realpathSync(args.repo)
    } catch {
      return 0
    }
    if (repoReal !== project.localPath || !SHA_PATTERN.test(args.sha)) {
      return 0
    }

    const commit = await getCommit(project.localPath, args.sha)
    if (commit === null || commit.sha === '') {
      return 0
    }

    const iso = now().toISOString()
    upsertCommit(db, {
      projectId: project.id,
      sha: commit.sha,
      parentSha: commit.parentSha,
      message: commit.message,
      authoredAt: commit.authoredAt !== '' ? commit.authoredAt : iso,
      detectedAt: iso,
    })

    const enqueued = enqueueGeneration(
      db,
      { projectId: project.id, sha: commit.sha, mode: 'generation', trigger: 'post_commit' },
      now,
    )
    if (enqueued.shouldSpawn && enqueued.ownerToken !== null) {
      startGenerationWorker(db, enqueued.scope, enqueued.ownerToken, enqueued.runId, deps)
    }
    return 0
  } finally {
    if (ownDb) {
      db.close()
    }
  }
}
