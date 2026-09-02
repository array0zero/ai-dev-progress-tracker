import { homedir } from 'node:os'
import { resolve } from 'node:path'

export interface AppConfig {
  /** Server bind host is fixed to loopback and is not configurable. */
  readonly host: '127.0.0.1'
  readonly port: number
  readonly dataDir: string
  readonly dbPath: string
  readonly logsDir: string
  readonly logFilePath: string
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
    logsDir: resolve(dataDir, 'logs'),
    logFilePath: resolve(dataDir, 'logs', 'app.log'),
    webRoot: resolve(process.cwd(), 'dist', 'web'),
  }
}

// --- external runtime / CLI version checks -----------------------------------
//
// DESIGN.md v1.2: version文字列から最初の MAJOR.MINOR.PATCH を抽出し、
// 3整数tupleを左から比較する。追加のsemver packageは使わない。
// server起動時・doctor・Codex adapter がこの関数を共有する。

export type VersionTuple = readonly [number, number, number]

export interface VersionRequirement {
  readonly min: VersionTuple
  readonly unsupportedCode: string
}

export const VERSION_PARSE_ERROR = 'VERSION_PARSE_ERROR'

// DESIGN v2.1: 下限のみを固定し、上限は設定しない。
export const VERSION_REQUIREMENTS = {
  node: { min: [24, 15, 0], unsupportedCode: 'NODE_VERSION_UNSUPPORTED' },
  git: { min: [2, 45, 0], unsupportedCode: 'GIT_VERSION_UNSUPPORTED' },
  gh: { min: [2, 98, 0], unsupportedCode: 'GH_VERSION_UNSUPPORTED' },
  codex: { min: [0, 152, 0], unsupportedCode: 'CODEX_VERSION_UNSUPPORTED' },
  claude: { min: [2, 1, 258], unsupportedCode: 'CLAUDE_VERSION_UNSUPPORTED' },
} as const satisfies Record<string, VersionRequirement>

export function extractVersion(raw: string): VersionTuple | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/)
  if (match === null) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersionTuples(a: VersionTuple, b: VersionTuple): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) {
      return diff < 0 ? -1 : 1
    }
  }
  return 0
}

export type VersionCheckResult =
  | { readonly ok: true; readonly version: VersionTuple }
  | { readonly ok: false; readonly code: string }

export function checkVersion(raw: string, requirement: VersionRequirement): VersionCheckResult {
  const version = extractVersion(raw)
  if (version === null) {
    return { ok: false, code: VERSION_PARSE_ERROR }
  }
  if (compareVersionTuples(version, requirement.min) < 0) {
    return { ok: false, code: requirement.unsupportedCode }
  }
  return { ok: true, version }
}
