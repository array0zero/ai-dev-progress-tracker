import { realpathSync } from 'node:fs'
import { getActiveLogin } from '../../server/adapters/github.js'
import { loadConfig } from '../../server/config.js'
import { type Db, openDatabase } from '../../server/db/connection.js'
import { getProjectById } from '../../server/db/project-repository.js'
import {
  BACKUP_REPO_SUFFIX,
  type BackupSpawnDeps,
  enqueueBackup,
  startBackupWorker,
} from '../../server/services/backup-service.js'

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i

export interface HookBackupArgs {
  projectId: string
  repo: string
  sha: string
}

export interface HookBackupDeps extends BackupSpawnDeps {
  db?: Db
  now?: () => Date
}

/**
 * pre-push hook から呼ばれる。backup run だけを queue する (generation は呼ばない)。
 * push 自体は妨げず 2 秒以内に返す。
 */
export async function runHookBackup(
  args: HookBackupArgs,
  deps: HookBackupDeps = {},
): Promise<number> {
  const ownDb = deps.db === undefined
  const db = deps.db ?? openDatabase(loadConfig().dbPath)
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

    const login = await getActiveLogin()
    const backupRepo = login === null ? BACKUP_REPO_SUFFIX : `${login}/${BACKUP_REPO_SUFFIX}`

    const enqueued = enqueueBackup(
      db,
      {
        trigger: 'pre_push',
        projectId: project.id,
        sourceCommitSha: args.sha,
        backupRepo,
      },
      deps.now,
    )
    if (enqueued.shouldSpawn && enqueued.ownerToken !== null) {
      startBackupWorker(db, enqueued.ownerToken, enqueued.runId, deps)
    }
    return 0
  } finally {
    if (ownDb) {
      db.close()
    }
  }
}
