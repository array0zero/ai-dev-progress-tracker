import { randomUUID } from 'node:crypto'
import type { ProjectDetail } from '../../shared/api.js'
import { getHeadCommit, inspectRepository } from '../adapters/git.js'
import { checkAuth, viewRepo } from '../adapters/github.js'
import type { Db } from '../db/connection.js'
import {
  findProjectByLocalPath,
  findProjectByRepoNodeId,
  insertProject,
  type ProjectRecord,
} from '../db/project-repository.js'
import { upsertCommit } from '../db/run-repository.js'
import type { RegisterProjectRequest } from '../schemas/project.js'
import { startGenerationWorker } from './generation-service.js'
import { assertHooksInstallable, installHooks } from './hook-service.js'
import { enqueueRecovery } from './recovery-service.js'

export interface RegisterProjectOptions {
  now?: () => Date
  /** false で登録後の自動 recovery enqueue を抑止する (テスト用)。 */
  autoRecover?: boolean
  /** recovery worker の spawn を差し替える (テスト用)。 */
  spawnWorker?: (scope: string, ownerToken: string) => void
}

export interface RegisterProjectFailure {
  ok: false
  status: number
  code: string
  message: string
}

export interface RegisterProjectSuccess {
  ok: true
  project: ProjectDetail
}

export type RegisterProjectResult = RegisterProjectSuccess | RegisterProjectFailure

const MESSAGES: Record<string, string> = {
  NOT_GIT_ROOT: 'The given path is not the root of a Git repository.',
  GIT_LAYOUT_UNSUPPORTED:
    'This Git layout (linked worktree or non-standard .git) is not supported.',
  CUSTOM_HOOKS_PATH_UNSUPPORTED: 'Repositories with core.hooksPath configured are not supported.',
  REPOSITORY_MISMATCH: 'The origin remote does not match the requested GitHub repository.',
  GITHUB_AUTH_REQUIRED: 'GitHub CLI authentication is required.',
  HOOK_UNSUPPORTED: 'An existing Git hook without a shebang cannot be modified.',
  PROJECT_ALREADY_REGISTERED: 'This local path or repository is already registered.',
}

function fail(status: number, code: string): RegisterProjectFailure {
  return { ok: false, status, code, message: MESSAGES[code] ?? 'Registration failed.' }
}

function toDetail(project: ProjectRecord, lastCommitSha: string | null): ProjectDetail {
  return {
    id: project.id,
    name: project.name,
    repository: `${project.repoOwner}/${project.repoName}`,
    repositoryUrl: project.repoUrl,
    lastCommitSha,
    progressStatus: null,
    currentPosition: null,
    completedItems: [],
    nextActions: [],
    generationStatus: null,
    backupStatus: null,
    importantDecisions: [],
    allEvidence: [],
    missingFields: [],
  }
}

/**
 * DESIGN.md「固定検証順」1〜15 を実装する。
 * 15: snapshot がないため `recovery` run を自動 enqueue する。
 * 16 (backup enqueue) は T014。
 */
export async function registerProject(
  input: RegisterProjectRequest,
  db: Db,
  options: RegisterProjectOptions = {},
): Promise<RegisterProjectResult> {
  const now = options.now ?? (() => new Date())
  // 1〜8: local Git root / layout / origin 帰属
  const inspection = await inspectRepository(input.localPath, input.repository)
  if (!inspection.ok) {
    return fail(422, inspection.code)
  }
  const { layout } = inspection

  // 9: gh 認証
  if (!(await checkAuth())) {
    return fail(422, 'GITHUB_AUTH_REQUIRED')
  }

  // 10: gh repo view
  const repoView = await viewRepo(input.repository)
  if (!repoView.ok) {
    return fail(422, 'REPOSITORY_MISMATCH')
  }

  // 11: 重複登録
  if (
    findProjectByLocalPath(db, layout.root) !== null ||
    findProjectByRepoNodeId(db, repoView.repo.id) !== null
  ) {
    return fail(409, 'PROJECT_ALREADY_REGISTERED')
  }

  // HOOK_UNSUPPORTED の場合に DB 保存しないよう、書き込み前に設置可能性を確認する。
  const hookPreflight = await assertHooksInstallable(layout.gitDir)
  if (!hookPreflight.ok) {
    return fail(422, 'HOOK_UNSUPPORTED')
  }

  const timestamp = now()
  const iso = timestamp.toISOString()
  const [owner, name] = repoView.repo.nameWithOwner.split('/')

  // 12: DB 保存
  const project = insertProject(
    db,
    {
      id: randomUUID(),
      name: input.name,
      localPath: layout.root,
      repoNodeId: repoView.repo.id,
      repoOwner: owner ?? layout.origin.owner,
      repoName: name ?? layout.origin.repo,
      repoUrl: repoView.repo.url,
      defaultBranch: repoView.repo.defaultBranch ?? 'main',
      status: 'active',
    },
    timestamp,
  )

  // 13: hook 設置
  const hookResult = await installHooks(layout.gitDir, project.id)
  if (!hookResult.ok) {
    return fail(422, 'HOOK_UNSUPPORTED')
  }

  // 14: 最新 HEAD commit を登録
  const head = await getHeadCommit(layout.root)
  let lastCommitSha: string | null = null
  if (head !== null && head.sha !== '') {
    upsertCommit(db, {
      projectId: project.id,
      sha: head.sha,
      parentSha: head.parentSha,
      message: head.message,
      authoredAt: head.authoredAt !== '' ? head.authoredAt : iso,
      detectedAt: iso,
    })
    lastCommitSha = head.sha
  }

  // 15: snapshot がないため recovery run を自動 enqueue する。
  if (options.autoRecover !== false && lastCommitSha !== null) {
    const recovery = enqueueRecovery(db, project.id, 'registration', now)
    if (recovery.ok && recovery.shouldSpawn && recovery.ownerToken !== null) {
      startGenerationWorker(db, recovery.scope, recovery.ownerToken, recovery.runId, {
        spawnWorker: options.spawnWorker,
      })
    }
  }

  return { ok: true, project: toDetail(project, lastCommitSha) }
}
