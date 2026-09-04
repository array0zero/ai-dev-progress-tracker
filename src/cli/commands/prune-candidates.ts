import { existsSync } from 'node:fs'
import { type AppConfig, loadConfig } from '../../server/config.js'
import { deleteCandidate, listCandidates } from '../../server/db/candidate-repository.js'
import { type Db, openDatabase } from '../../server/db/connection.js'
import { isExcludedProjectPath } from './agent-event.js'

export interface PruneCandidatesArgs {
  dryRun?: boolean
}

export interface PruneCandidatesOptions {
  config?: AppConfig
  db?: Db
}

export interface PrunablePath {
  id: string
  localPath: string
  reason: 'excluded_path' | 'missing_path'
}

/**
 * 誤検出 candidate の整理対象を選ぶ。
 * - OS temp 配下 / home そのもの (実機テストやツールの一時フォルダ)
 * - local path が既に存在しない
 * `registered` の candidate は project と紐づくので対象にしない。
 */
export function findPrunableCandidates(db: Db): PrunablePath[] {
  return listCandidates(db)
    .filter((candidate) => candidate.status !== 'registered')
    .map((candidate) => {
      if (isExcludedProjectPath(candidate.localPath)) {
        return {
          id: candidate.id,
          localPath: candidate.localPath,
          reason: 'excluded_path' as const,
        }
      }
      if (!existsSync(candidate.localPath)) {
        return { id: candidate.id, localPath: candidate.localPath, reason: 'missing_path' as const }
      }
      return null
    })
    .filter((entry): entry is PrunablePath => entry !== null)
}

/** 誤検出 candidate を一覧表示し、`--dry-run` でなければ削除する。 */
export function runPruneCandidates(
  args: PruneCandidatesArgs = {},
  options: PruneCandidatesOptions = {},
): number {
  const config = options.config ?? loadConfig()
  const ownsDb = options.db === undefined
  const db = options.db ?? openDatabase(config.dbPath)
  try {
    const targets = findPrunableCandidates(db)
    for (const target of targets) {
      process.stdout.write(
        `${args.dryRun === true ? 'DRY ' : ''}${target.reason} ${target.localPath}\n`,
      )
      if (args.dryRun !== true) {
        deleteCandidate(db, target.id)
      }
    }
    process.stdout.write(
      `${args.dryRun === true ? 'would remove' : 'removed'} ${targets.length} candidate(s)\n`,
    )
    return 0
  } finally {
    if (ownsDb && db.open) {
      db.close()
    }
  }
}
