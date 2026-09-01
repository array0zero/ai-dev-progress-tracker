import { buildApp } from './app.js'
import { checkVersion, loadConfig, VERSION_REQUIREMENTS } from './config.js'
import { openDatabase } from './db/connection.js'
import { createLogger } from './logging.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config.logFilePath)

  // server起動前にも doctor と同一の判定関数で Node.js version を確認する。
  // minimum未満 / 上限超過 / parse不能なら listen を開始せず終了する。
  const nodeCheck = checkVersion(process.versions.node, VERSION_REQUIREMENTS.node)
  if (!nodeCheck.ok) {
    logger.error('Node.js runtime is not supported; server will not start', {
      errorCode: nodeCheck.code,
      nodeVersion: process.versions.node,
    })
    process.stderr.write(`${nodeCheck.code}: Node.js ${process.versions.node} is not supported.\n`)
    process.exitCode = 1
    return
  }

  const db = openDatabase(config.dbPath)
  const app = await buildApp({ config, db })
  await app.listen({ host: config.host, port: config.port })
  logger.info('server listening', { host: config.host, port: config.port })
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
