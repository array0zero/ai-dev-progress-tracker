import { homedir } from 'node:os'
import { resolve } from 'node:path'

export interface AppConfig {
  /** Server bind host is fixed to loopback and is not configurable. */
  readonly host: '127.0.0.1'
  readonly port: number
  readonly dataDir: string
  readonly dbPath: string
  readonly webRoot: string
}

const DEFAULT_PORT = 4317
const MIN_PORT = 1
const MAX_PORT = 65535

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    throw new Error(`Invalid TRACKER_PORT: ${raw}`)
  }
  return value
}

function resolveDataDir(raw: string | undefined): string {
  if (raw !== undefined && raw.trim() !== '') {
    return resolve(raw)
  }
  return resolve(homedir(), '.ai-dev-progress-tracker')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = resolveDataDir(env.TRACKER_DATA_DIR)
  return {
    host: '127.0.0.1',
    port: parsePort(env.TRACKER_PORT),
    dataDir,
    dbPath: resolve(dataDir, 'tracker.db'),
    webRoot: resolve(process.cwd(), 'dist', 'web'),
  }
}
