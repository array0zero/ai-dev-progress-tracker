import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { isServerHealthy, openUrl, spawnDetachedServer } from '../../server/adapters/desktop.js'
import { runProcess } from '../../server/adapters/process-runner.js'
import { type AppConfig, loadConfig } from '../../server/config.js'
import { markPrompted, upsertDetected } from '../../server/db/candidate-repository.js'
import { type Db, openDatabase } from '../../server/db/connection.js'
import { listProjects } from '../../server/db/project-repository.js'
import { createLogger, type Logger } from '../../server/logging.js'
import { defaultServerEntry } from '../../server/services/agent-integration-service.js'

/** DESIGN「外部CLI timeout/retry」: agent-event local processing は合計 5 秒。 */
const TOTAL_BUDGET_MS = 5_000
const GIT_BUDGET_MS = 3_000
const SERVER_READY_TIMEOUT_MS = 3_000
const SERVER_POLL_INTERVAL_MS = 100

export interface AgentEventArgs {
  agent: 'codex' | 'claude'
  input: 'argv' | 'stdin'
  /** `--input argv` のときの末尾 JSON。 */
  payload?: string
}

export interface AgentEventOptions {
  config?: AppConfig
  db?: Db
  now?: () => Date
  readStdin?: () => Promise<string>
  openUrl?: (url: string) => Promise<boolean>
  ensureServer?: (config: AppConfig) => Promise<boolean>
  logger?: Logger
}

function readStdinText(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY === true) {
      resolve('')
      return
    }
    const chunks: Buffer[] = []
    const finish = (): void => resolve(Buffer.concat(chunks).toString('utf8'))
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', finish)
    process.stdin.on('error', () => resolve(''))
    setTimeout(finish, 2_000).unref()
  })
}

/** event payload からは event 種別と cwd だけを取り出す。会話本文は読まない。 */
export function extractWorkdir(agent: 'codex' | 'claude', raw: string): string | null {
  if (raw.trim() === '') {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const payload = parsed as Record<string, unknown>
  const expectedEvent =
    agent === 'codex'
      ? payload.type === 'agent-turn-complete'
      : payload.hook_event_name === 'UserPromptSubmit'
  if (!expectedEvent) {
    return null
  }
  return typeof payload.cwd === 'string' ? payload.cwd : null
}

/** Git 配下なら top-level、Git 外なら cwd 自身を canonical local path にする。 */
async function canonicalizeWorkdir(cwd: string, budgetMs: number): Promise<string | null> {
  if (!isAbsolute(cwd)) {
    return null
  }
  let real: string
  try {
    real = realpathSync.native(cwd)
    if (!statSync(real).isDirectory()) {
      return null
    }
  } catch {
    return null
  }
  if (budgetMs <= 0) {
    return real
  }
  try {
    const top = await runProcess('git', ['-C', real, 'rev-parse', '--show-toplevel'], {
      timeoutMs: budgetMs,
    })
    if (top.code === 0 && top.stdout.trim() !== '') {
      return realpathSync.native(top.stdout.trim())
    }
  } catch {
    // Git 外 / git 不在は cwd をそのまま使う
  }
  return real
}

async function defaultEnsureServer(config: AppConfig): Promise<boolean> {
  if (await isServerHealthy(config.port)) {
    return true
  }
  // 起動する server が handler と同じ DB / port を使うよう明示的に渡す。
  const env = {
    ...process.env,
    TRACKER_DATA_DIR: config.dataDir,
    TRACKER_PORT: String(config.port),
  }
  if (!spawnDetachedServer(defaultServerEntry(), env)) {
    return false
  }
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isServerHealthy(config.port)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS))
  }
  return false
}

/**
 * Codex notify / Claude UserPromptSubmit の共通 handler。
 * agent 本体を失敗させないため、内部 error でも常に exit 0 を返す。
 */
export async function runAgentEvent(
  args: AgentEventArgs,
  options: AgentEventOptions = {},
): Promise<number> {
  const startedAt = Date.now()
  const config = options.config ?? loadConfig()
  const logger = options.logger ?? createLogger(config.logFilePath)
  const ownsDb = options.db === undefined
  let db: Db | null = null

  try {
    const raw =
      args.input === 'argv' ? (args.payload ?? '') : await (options.readStdin ?? readStdinText)()
    const cwd = extractWorkdir(args.agent, raw)
    if (cwd === null) {
      logger.info('agent event ignored', { agent: args.agent })
      return 0
    }

    const remainingForGit = Math.min(GIT_BUDGET_MS, TOTAL_BUDGET_MS - (Date.now() - startedAt))
    const localPath = await canonicalizeWorkdir(cwd, remainingForGit)
    if (localPath === null) {
      logger.warn('agent event has an unusable cwd', { agent: args.agent })
      return 0
    }

    db = options.db ?? openDatabase(config.dbPath)
    if (listProjects(db).some((project) => project.localPath === localPath)) {
      return 0
    }

    const candidate = upsertDetected(
      db,
      { localPath, agent: args.agent, suggestedName: basename(localPath).slice(0, 120) },
      options.now?.() ?? new Date(),
    )
    logger.info('registration candidate detected', {
      candidate_id: candidate.id,
      agent: args.agent,
    })

    if (candidate.status !== 'detected') {
      return 0
    }
    if (Date.now() - startedAt >= TOTAL_BUDGET_MS) {
      return 0
    }

    const ready = await (options.ensureServer ?? defaultEnsureServer)(config)
    if (!ready) {
      logger.warn('server was not reachable for the registration prompt', {
        candidate_id: candidate.id,
      })
      return 0
    }

    const url = `http://127.0.0.1:${config.port}/?candidate=${candidate.id}`
    const opened = await (options.openUrl ?? openUrl)(url)
    if (!opened) {
      logger.warn('could not open the registration prompt', {
        candidate_id: candidate.id,
        error_code: 'BROWSER_OPEN_FAILED',
      })
      return 0
    }
    markPrompted(db, candidate.id, options.now?.() ?? new Date())
    return 0
  } catch {
    logger.error('agent event failed', { agent: args.agent, error_code: 'INTERNAL_ERROR' })
    return 0
  } finally {
    if (ownsDb && db?.open === true) {
      db.close()
    }
  }
}
