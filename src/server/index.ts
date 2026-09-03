import { buildApp } from './app.js'
import { checkVersion, loadConfig, VERSION_REQUIREMENTS } from './config.js'
import { openDatabase } from './db/connection.js'
import { createLogger } from './logging.js'

/** 親プロセス生存確認の間隔。 */
const PARENT_WATCHDOG_INTERVAL_MS = 1_000

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
  // listen host は config で `127.0.0.1` 固定 (env で変更不可)。internet 公開しない。
  await app.listen({ host: config.host, port: config.port })
  logger.info('server listening', { host: config.host, port: config.port })

  // 親 (Playwright webServer / npm start) から止められたときに listen socket と
  // SQLite handle を確実に閉じる。閉じ忘れると Windows で temp dir が掴まれたままになる。
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    logger.info('server shutting down', { signal })
    void app
      .close()
      .catch(() => undefined)
      .finally(() => {
        if (db.open) {
          db.close()
        }
        process.exit(0)
      })
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => shutdown(signal))
  }

  // signal が届かない環境 (sandbox / Windows の process tree kill 失敗) でも
  // 親が消えたら確実に終わるための watchdog。TRACKER_PARENT_PID がある時だけ動く。
  const parentPid = Number(process.env.TRACKER_PARENT_PID)
  if (Number.isInteger(parentPid) && parentPid > 0) {
    const timer = setInterval(() => {
      try {
        // signal 0 は送信せず存在確認だけ行う。EPERM は「居るが権限なし」なので生存扱い。
        process.kill(parentPid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          clearInterval(timer)
          shutdown('SIGTERM')
        }
      }
    }, PARENT_WATCHDOG_INTERVAL_MS)
    timer.unref()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
