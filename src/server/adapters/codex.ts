import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { checkVersion, VERSION_REQUIREMENTS } from '../config.js'
import { type RunResult, runProcess } from './process-runner.js'

const CODEX_MODEL = 'gpt-5.6-terra'
const VERSION_TIMEOUT_MS = 20_000
const AUTH_TIMEOUT_MS = 20_000
const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const CHATGPT_MARKER = /Logged in using ChatGPT/i
const API_KEY_MARKER = /API key/i

const argsPrefixSchema = z.array(z.string())

interface CodexInvoker {
  bin: string
  prefixArgs: string[]
}

/** 既定は PATH 上の `codex`。テストは TRACKER_CODEX_BIN / TRACKER_CODEX_ARGS で fake を注入する。 */
function resolveCodex(): CodexInvoker {
  const bin = process.env.TRACKER_CODEX_BIN
  if (bin === undefined || bin === '') {
    return { bin: 'codex', prefixArgs: [] }
  }
  const rawArgs = process.env.TRACKER_CODEX_ARGS
  const prefixArgs =
    rawArgs === undefined || rawArgs === '' ? [] : argsPrefixSchema.parse(JSON.parse(rawArgs))
  return { bin, prefixArgs }
}

export function progressSchemaPath(): string {
  // dist/server/adapters/codex.js -> schemas/progress-output.schema.json (repo root)
  return fileURLToPath(new URL('../../../schemas/progress-output.schema.json', import.meta.url))
}

export type CodexReadyResult = { ok: true; version: string } | { ok: false; code: string }

/**
 * Codex 実行直前の検査。version 下限 (>=0.146.0) → ChatGPT 認証の順で確認する。
 * raw 出力は保持・表示しない。
 */
export async function checkCodexReady(): Promise<CodexReadyResult> {
  const codex = resolveCodex()

  let versionRun: RunResult
  try {
    versionRun = await runProcess(codex.bin, [...codex.prefixArgs, '--version'], {
      timeoutMs: VERSION_TIMEOUT_MS,
    })
  } catch {
    return { ok: false, code: 'CODEX_VERSION_UNSUPPORTED' }
  }
  if (versionRun.timedOut) {
    return { ok: false, code: 'CODEX_VERSION_UNSUPPORTED' }
  }
  const check = checkVersion(
    `${versionRun.stdout}\n${versionRun.stderr}`,
    VERSION_REQUIREMENTS.codex,
  )
  if (!check.ok) {
    return { ok: false, code: check.code }
  }

  let authRun: RunResult
  try {
    authRun = await runProcess(codex.bin, [...codex.prefixArgs, 'login', 'status'], {
      timeoutMs: AUTH_TIMEOUT_MS,
    })
  } catch {
    return { ok: false, code: 'CODEX_AUTH_REQUIRED' }
  }
  const combined = `${authRun.stdout}\n${authRun.stderr}`
  if (CHATGPT_MARKER.test(combined)) {
    return { ok: true, version: check.version.join('.') }
  }
  if (API_KEY_MARKER.test(combined)) {
    return { ok: false, code: 'AI_AUTH_NOT_CHATGPT' }
  }
  return { ok: false, code: 'CODEX_AUTH_REQUIRED' }
}

export interface CodexExecOptions {
  schemaPath?: string
  timeoutMs?: number
}

export type CodexExecResult = { ok: true; output: unknown } | { ok: false; code: string }

const OPENAI_ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'] as const

/**
 * DESIGN.md 固定 argv で Codex exec を起動する。
 * cwd は OS temp 配下の空ディレクトリ、stdin は prompt、子環境から OPENAI_* を除去する。
 * exit 0 かつ output file が valid JSON の場合だけ output を返す。
 */
export async function runCodexGeneration(
  promptText: string,
  options: CodexExecOptions = {},
): Promise<CodexExecResult> {
  const codex = resolveCodex()
  const workDir = mkdtempSync(join(tmpdir(), 'adpt-codex-'))
  const outputFile = join(workDir, 'progress.json')
  const schemaPath = options.schemaPath ?? progressSchemaPath()

  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const key of OPENAI_ENV_KEYS) {
    delete childEnv[key]
  }

  try {
    const result = await runProcess(
      codex.bin,
      [
        ...codex.prefixArgs,
        '--model',
        CODEX_MODEL,
        '--ask-for-approval',
        'never',
        '--sandbox',
        'read-only',
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputFile,
        '-',
      ],
      {
        cwd: workDir,
        env: childEnv,
        input: promptText,
        timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      },
    )

    if (result.timedOut) {
      return { ok: false, code: 'CODEX_TIMEOUT' }
    }
    if (result.code !== 0) {
      return { ok: false, code: 'CODEX_EXEC_FAILED' }
    }

    let text: string
    try {
      text = readFileSync(outputFile, 'utf8')
    } catch {
      return { ok: false, code: 'CODEX_OUTPUT_MISSING' }
    }
    try {
      return { ok: true, output: JSON.parse(text) }
    } catch {
      return { ok: false, code: 'CODEX_OUTPUT_INVALID' }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
