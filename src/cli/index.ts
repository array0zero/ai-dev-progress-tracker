import { parseArgs } from 'node:util'
import { runDoctor } from './commands/doctor.js'
import { runHookBackup } from './commands/hook-backup.js'
import { type HookCommitArgs, runHookCommit } from './commands/hook-commit.js'

function parseHookArgs(argv: readonly string[]): HookCommitArgs | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'project-id': { type: 'string' },
      repo: { type: 'string' },
      sha: { type: 'string' },
    },
    strict: false,
  })
  const projectId = values['project-id']
  const repo = values.repo
  const sha = values.sha
  if (typeof projectId !== 'string' || typeof repo !== 'string' || typeof sha !== 'string') {
    return null
  }
  return { projectId, repo, sha }
}

async function dispatch(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'doctor':
      return runDoctor()
    case 'hook-commit': {
      const parsed = parseHookArgs(rest)
      if (parsed === null) {
        process.stderr.write('hook-commit: --project-id, --repo and --sha are required\n')
        return 2
      }
      return runHookCommit(parsed)
    }
    case 'hook-backup': {
      const parsed = parseHookArgs(rest)
      if (parsed === null) {
        process.stderr.write('hook-backup: --project-id, --repo and --sha are required\n')
        return 2
      }
      return runHookBackup(parsed)
    }
    default:
      process.stderr.write(`Unknown command: ${command ?? '(none)'}\n`)
      return 2
  }
}

dispatch(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
