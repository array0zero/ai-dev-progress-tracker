import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactSecrets } from './security/redaction.js'

export type LogLevel = 'info' | 'warn' | 'error'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_LOG_GENERATIONS = 5

export type LogMeta = Record<string, unknown>

export interface Logger {
  info: (message: string, meta?: LogMeta) => void
  warn: (message: string, meta?: LogMeta) => void
  error: (message: string, meta?: LogMeta) => void
}

function rotateIfNeeded(logFilePath: string): void {
  let size: number
  try {
    size = statSync(logFilePath).size
  } catch {
    return
  }
  if (size < MAX_LOG_BYTES) {
    return
  }
  for (let generation = MAX_LOG_GENERATIONS - 1; generation >= 1; generation -= 1) {
    try {
      renameSync(`${logFilePath}.${generation}`, `${logFilePath}.${generation + 1}`)
    } catch {
      // その世代がまだ存在しないだけ。
    }
  }
  try {
    renameSync(logFilePath, `${logFilePath}.1`)
  } catch {
    // 直近ファイルがなければrotate不要。
  }
}

/**
 * JSON Lines を app.log へ追記するlogger。
 * meta は redactSecrets を通してから書き込む。child processのenv全体やprompt/AI raw出力は渡さないこと。
 */
export function createLogger(logFilePath: string): Logger {
  mkdirSync(dirname(logFilePath), { recursive: true })

  const write = (level: LogLevel, message: string, meta?: LogMeta): void => {
    rotateIfNeeded(logFilePath)
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      message,
    }
    if (meta !== undefined) {
      record.meta = redactSecrets(meta)
    }
    appendFileSync(logFilePath, `${JSON.stringify(record)}\n`, 'utf8')
  }

  return {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  }
}
