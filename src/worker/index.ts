import { parseArgs } from 'node:util'
import { loadConfig } from '../server/config.js'
import { openDatabase } from '../server/db/connection.js'
import { processGenerationQueue } from './generation-worker.js'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scope: { type: 'string' },
      token: { type: 'string' },
    },
    strict: false,
  })

  const scope = values.scope
  const token = values.token
  if (typeof scope !== 'string' || typeof token !== 'string') {
    process.stderr.write('worker: --scope and --token are required\n')
    process.exitCode = 2
    return
  }

  const db = openDatabase(loadConfig().dbPath)
  try {
    await processGenerationQueue(db, scope, token)
  } finally {
    db.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
