import { loadConfig } from '../../server/config.js'
import {
  type PerformRestoreOptions,
  performRestore,
} from '../../server/services/restore-service.js'

export interface RestoreArgs {
  force: boolean
}

/**
 * `restore` / `restore --force`。
 * 既存 tracker.db があり `--force` なしなら exit 2。それ以外の失敗は exit 1、成功は exit 0。
 */
export async function runRestore(
  args: RestoreArgs,
  overrides: PerformRestoreOptions = {},
): Promise<number> {
  const config = loadConfig()
  const result = await performRestore(config, { force: args.force, ...overrides })

  if (!result.ok) {
    process.stderr.write(`restore failed: ${result.code ?? 'ERROR'} — ${result.reason ?? ''}\n`)
    return result.exitCode
  }

  process.stdout.write(
    `restore: ${result.restoredProjects ?? 0} project(s), hooks reinstalled for ` +
      `${(result.reinstalledHooks ?? []).length}, local_missing ${(result.localMissing ?? []).length}\n`,
  )
  if (result.preRestorePath !== null && result.preRestorePath !== undefined) {
    process.stdout.write(`previous DB moved to ${result.preRestorePath}\n`)
  }
  return 0
}
