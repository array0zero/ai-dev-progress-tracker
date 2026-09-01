import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeCodexConfig {
  /** `codex --version` の出力 */
  version?: string
  /** `codex --version` の exit code (0 以外なら取得失敗扱い) */
  versionExitCode?: number
  /** `codex login status` の認証モード */
  authMode?: 'chatgpt' | 'apikey' | 'none'
  /** exec の exit code (0 以外なら失敗) */
  execExitCode?: number
  /** exec が output-last-message へ書く内容 (JSON にして書く) */
  output?: unknown
  /** exec が output-last-message へ verbatim で書く内容 (invalid JSON テスト用) */
  outputRaw?: string
}

export interface FakeCodex {
  env: Record<string, string>
  calls: () => string[][]
  /** exec 時の子環境に OPENAI_* が残っていたか */
  envDump: () => Record<string, string | null>
  /** exec へ渡された prompt */
  prompt: () => string
  cleanup: () => void
}

const FAKE_CODEX_SOURCE = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const cfg = JSON.parse(readFileSync(process.env.FAKE_CODEX_CONFIG, 'utf8'))
appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(argv) + '\\n')

if (argv.includes('--version')) {
  process.stdout.write((cfg.version ?? 'codex-cli 0.146.0') + '\\n')
  process.exit(cfg.versionExitCode ?? 0)
}

if (argv[0] === 'login' && argv[1] === 'status') {
  const mode = cfg.authMode ?? 'chatgpt'
  if (mode === 'chatgpt') process.stdout.write('Logged in using ChatGPT\\n')
  else if (mode === 'apikey') process.stdout.write('Logged in using API key\\n')
  else process.stdout.write('Not logged in\\n')
  process.exit(0)
}

const outIndex = argv.indexOf('--output-last-message')
const outPath = outIndex !== -1 ? argv[outIndex + 1] : null

writeFileSync(
  process.env.FAKE_CODEX_ENV_DUMP,
  JSON.stringify({
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    OPENAI_ORG_ID: process.env.OPENAI_ORG_ID ?? null,
    OPENAI_PROJECT_ID: process.env.OPENAI_PROJECT_ID ?? null,
  }),
)

let prompt = ''
process.stdin.on('data', (chunk) => {
  prompt += chunk
})
process.stdin.on('end', () => {
  writeFileSync(process.env.FAKE_CODEX_PROMPT_DUMP, prompt)
  const exitCode = cfg.execExitCode ?? 0
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
  if (outPath) {
    const body =
      cfg.outputRaw !== undefined ? cfg.outputRaw : JSON.stringify(cfg.output ?? {})
    writeFileSync(outPath, body)
  }
  process.exit(0)
})
`

export function writeFakeCodex(
  dir: string,
  config: FakeCodexConfig = {},
): { env: Record<string, string>; callsPath: string; envDumpPath: string; promptDumpPath: string } {
  mkdirSync(dir, { recursive: true })
  const scriptPath = join(dir, 'fake-codex.mjs')
  const configPath = join(dir, 'config.json')
  const callsPath = join(dir, 'calls.jsonl')
  const envDumpPath = join(dir, 'env-dump.json')
  const promptDumpPath = join(dir, 'prompt.txt')

  writeFileSync(scriptPath, FAKE_CODEX_SOURCE)
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(callsPath, '')

  return {
    env: {
      TRACKER_CODEX_BIN: process.execPath,
      TRACKER_CODEX_ARGS: JSON.stringify([scriptPath]),
      FAKE_CODEX_CONFIG: configPath,
      FAKE_CODEX_CALLS: callsPath,
      FAKE_CODEX_ENV_DUMP: envDumpPath,
      FAKE_CODEX_PROMPT_DUMP: promptDumpPath,
    },
    callsPath,
    envDumpPath,
    promptDumpPath,
  }
}

export function createFakeCodex(config: FakeCodexConfig = {}): FakeCodex {
  const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'))
  const written = writeFakeCodex(dir, config)

  function readJson(path: string): Record<string, string | null> {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string | null>
    } catch {
      return {}
    }
  }

  return {
    env: written.env,
    calls: () =>
      readFileSync(written.callsPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[]),
    envDump: () => readJson(written.envDumpPath),
    prompt: () => {
      try {
        return readFileSync(written.promptDumpPath, 'utf8')
      } catch {
        return ''
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
