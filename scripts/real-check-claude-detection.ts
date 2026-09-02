/**
 * 実機 Claude Code で F1 の Claude 検知経路を確認する。CI では実行しない。
 *
 * 使い方:
 *   npm run real:claude-detection
 *
 * 隔離条件 (AGENTS.md):
 * - project / settings / TRACKER_DATA_DIR は OS temp のみ。終了時に temp だけ削除する。
 * - user `~/.claude/settings.json` は読むだけ (SHA-256 で不変を確認)。
 * - `claude --restricted -p --settings <temp>` で tracker hook を注入する。
 * - `claude auth status` は exit code と loggedIn だけを見る。raw 出力は保存も表示もしない。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runAgentEvent } from '../src/cli/commands/agent-event.js'
import { runProcess } from '../src/server/adapters/process-runner.js'
import { checkVersion, loadConfig, VERSION_REQUIREMENTS } from '../src/server/config.js'
import { listCandidates } from '../src/server/db/candidate-repository.js'
import { openDatabase } from '../src/server/db/connection.js'
import {
  applyClaudeHook,
  resolveIntegration,
} from '../src/server/services/agent-integration-service.js'

const CLI_TIMEOUT_MS = 30_000
const PROMPT_TIMEOUT_MS = 180_000
const CANDIDATE_POLL_TIMEOUT_MS = 15_000
const CANDIDATE_POLL_INTERVAL_MS = 250
const PROMPT = 'Reply with exactly OK. Do not create, modify or delete any files.'

function sha256OfFile(path: string): string | null {
  if (!existsSync(path)) {
    return null
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function repoStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: process.cwd(), encoding: 'utf8' })
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function candidateCount(dbPath: string): number {
  if (!existsSync(dbPath)) {
    return 0
  }
  const db = openDatabase(dbPath)
  try {
    return listCandidates(db).length
  } finally {
    db.close()
  }
}

/** exit code と loggedIn だけを見る。email / orgId など raw の中身は保持しない。 */
async function checkClaudeAuth(): Promise<boolean> {
  const result = await runProcess('claude', ['auth', 'status'], { timeoutMs: CLI_TIMEOUT_MS })
  if (result.timedOut || result.code !== 0) {
    return false
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout)
    return (parsed as { loggedIn?: unknown }).loggedIn === true
  } catch {
    return false
  }
}

async function main(): Promise<number> {
  const cliPath = resolve(process.cwd(), 'dist/cli/index.js')
  if (!existsSync(cliPath)) {
    process.stdout.write('run "npm run build" first: dist/cli/index.js is missing\n')
    return 1
  }

  const report: Record<string, unknown> = { tool: 'real:claude-detection' }

  const versionRun = await runProcess('claude', ['--version'], { timeoutMs: CLI_TIMEOUT_MS })
  const version = checkVersion(
    `${versionRun.stdout}\n${versionRun.stderr}`,
    VERSION_REQUIREMENTS.claude,
  )
  if (!version.ok) {
    report.result = `STOP: ${version.code}`
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 1
  }
  report.claudeVersion = version.version.join('.')

  if (!(await checkClaudeAuth())) {
    report.result = 'STOP: claude auth status is not logged in (AGENTS.md stop condition)'
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 1
  }
  report.claudeAuth = 'logged in'

  const userSettings = join(homedir(), '.claude', 'settings.json')
  const userSettingsBefore = sha256OfFile(userSettings)
  const repoStatusBefore = repoStatus()

  const projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'adpt-real-claude-project-')))
  const homeDir = mkdtempSync(join(tmpdir(), 'adpt-real-claude-home-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'adpt-real-claude-data-'))
  const dbPath = loadConfig({ TRACKER_DATA_DIR: dataDir }).dbPath

  try {
    // installer が書く形の settings をそのまま temp home へ作る
    const integration = resolveIntegration({ home: homeDir, cliPath })
    const install = applyClaudeHook(integration, 'install')
    if (!install.ok) {
      report.result = `FAIL: could not build the temp settings (${install.code})`
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }
    const settingsPath = integration.claudeSettingsPath

    // prompt は stdin へ渡す。`--tools <tools...>` は可変長なので後続の positional を飲み込む。
    const run = await runProcess(
      'claude',
      ['--restricted', '-p', '--settings', settingsPath, '--tools', ''],
      {
        cwd: projectDir,
        input: PROMPT,
        env: {
          ...process.env,
          TRACKER_DATA_DIR: dataDir,
          TRACKER_PORT: '4319',
          TRACKER_AGENT_EVENT_PROMPT: 'off',
        },
        timeoutMs: PROMPT_TIMEOUT_MS,
      },
    )
    report.claudeExitCode = run.code
    report.claudeTimedOut = run.timedOut
    if (run.timedOut || run.code !== 0) {
      report.result = 'FAIL: claude -p did not complete the prompt'
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }

    const deadline = Date.now() + CANDIDATE_POLL_TIMEOUT_MS
    while (candidateCount(dbPath) === 0 && Date.now() < deadline) {
      await sleep(CANDIDATE_POLL_INTERVAL_MS)
    }

    const db = openDatabase(dbPath)
    let candidates = listCandidates(db)
    db.close()
    report.candidates = candidates.length
    report.candidatePath = candidates[0]?.localPath ?? null
    report.expectedPath = projectDir
    if (candidates.length !== 1 || candidates[0]?.localPath !== projectDir) {
      report.result = 'FAIL: the real Claude prompt did not produce exactly one candidate'
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }
    report.candidateAgent = candidates[0]?.agent
    report.candidateStatus = candidates[0]?.status

    const config = loadConfig({ TRACKER_DATA_DIR: dataDir, TRACKER_PORT: '4319' })
    for (const stdin of [
      '',
      'not json',
      JSON.stringify({ hook_event_name: 'SessionStart', cwd: projectDir }),
      JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
    ]) {
      await runAgentEvent(
        { agent: 'claude', input: 'stdin' },
        { config, readStdin: async () => stdin },
      )
    }
    const after = openDatabase(dbPath)
    candidates = listCandidates(after)
    after.close()
    report.candidatesAfterIgnoredEvents = candidates.length
    if (candidates.length !== 1) {
      report.result = 'FAIL: an ignored event changed the candidate table'
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }

    report.userClaudeSettingsUnchanged = sha256OfFile(userSettings) === userSettingsBefore
    report.repoWorkingTreeUnchanged = repoStatus() === repoStatusBefore
    if (report.userClaudeSettingsUnchanged !== true || report.repoWorkingTreeUnchanged !== true) {
      report.result = 'FAIL: an isolated resource was modified'
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }

    report.result = 'PASS'
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
