/**
 * 実機 Codex CLI で F1 の Codex 検知経路を確認する。CI では実行しない。
 *
 * 使い方:
 *   npm run real:codex-detection
 *
 * 隔離条件 (AGENTS.md):
 * - project / TRACKER_DATA_DIR は OS temp のみ。終了時に temp だけ削除する。
 * - user `~/.codex/config.toml` は読むだけ。notify は invocation-level `-c notify=[...]` で渡す。
 * - DESIGN v2.2 D006 の chain も同じ invocation-level notify で確認する (既存 notify を模した
 *   marker script を `--chain` へ渡し、tracker 検知と chain 起動の両方が起きることを見る)。
 * - 登録確認 (server 起動 / browser open) は TRACKER_AGENT_EVENT_PROMPT=off で抑止する。
 * - このリポジトリの working tree / DB は変更しない。
 * - installer 経路 (install → doctor → repair → uninstall) は、利用者の実 config を
 *   **temp HOME へ copy したもの**に対して実行する。実 file は読むだけで変更しない。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runAgentEvent } from '../src/cli/commands/agent-event.js'
import { checkCodexReady } from '../src/server/adapters/codex.js'
import { runProcess } from '../src/server/adapters/process-runner.js'
import { loadConfig } from '../src/server/config.js'
import { listCandidates } from '../src/server/db/candidate-repository.js'
import { openDatabase } from '../src/server/db/connection.js'
import {
  inspectAgentIntegration,
  resolveIntegration,
  setupAgents,
} from '../src/server/services/agent-integration-service.js'

const CODEX_MODEL = 'gpt-5.6-terra'
const EXEC_TIMEOUT_MS = 180_000
const CANDIDATE_POLL_TIMEOUT_MS = 15_000
const CANDIDATE_POLL_INTERVAL_MS = 250
const PROMPT = 'Reply with exactly OK. Do not create, modify or delete any files.'
const CHAIN_POLL_TIMEOUT_MS = 15_000

function sha256OfFile(path: string): string | null {
  if (!existsSync(path)) {
    return null
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function repoStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
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

async function main(): Promise<number> {
  const cliPath = resolve(process.cwd(), 'dist/cli/index.js')
  if (!existsSync(cliPath)) {
    process.stdout.write('run "npm run build" first: dist/cli/index.js is missing\n')
    return 1
  }

  const ready = await checkCodexReady()
  if (!ready.ok) {
    process.stdout.write(`STOP: Codex is not ready (${ready.code})\n`)
    return 1
  }

  const userCodexConfig = join(homedir(), '.codex', 'config.toml')
  const userConfigBefore = sha256OfFile(userCodexConfig)
  const repoStatusBefore = repoStatus()

  const projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'adpt-real-codex-project-')))
  const dataDir = mkdtempSync(join(tmpdir(), 'adpt-real-codex-data-'))
  const dbPath = loadConfig({ TRACKER_DATA_DIR: dataDir }).dbPath

  // 既存 notify を模した chain 対象。呼ばれたら marker file を書いて非 0 で終わる。
  const chainMarker = join(dataDir, 'chained-notify.txt')
  const chainArgv = [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(chainMarker)}, 'called'); process.exit(1)`,
  ]
  const notify = JSON.stringify([
    process.execPath,
    cliPath,
    'agent-event',
    '--agent',
    'codex',
    '--input',
    'argv',
    '--chain',
    JSON.stringify(chainArgv),
  ])

  const report: Record<string, unknown> = {
    tool: 'real:codex-detection',
    codexVersion: ready.version,
  }
  try {
    const exec = await runProcess(
      'codex',
      [
        '--model',
        CODEX_MODEL,
        '--ask-for-approval',
        'never',
        '--sandbox',
        'read-only',
        '-c',
        `notify=${notify}`,
        'exec',
        '--skip-git-repo-check',
        PROMPT,
      ],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          TRACKER_DATA_DIR: dataDir,
          TRACKER_PORT: '4319',
          TRACKER_AGENT_EVENT_PROMPT: 'off',
        },
        timeoutMs: EXEC_TIMEOUT_MS,
      },
    )
    report.codexExitCode = exec.code
    report.codexTimedOut = exec.timedOut
    if (exec.timedOut || exec.code !== 0) {
      report.result = 'FAIL: codex exec did not complete a turn'
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }

    // notify handler は codex の子プロセスなので、DB へ現れるまで少し待つ。
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
      report.result =
        'FAIL: the real Codex turn did not produce exactly one candidate for the temp folder'
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }
    report.candidateAgent = candidates[0]?.agent
    report.candidateStatus = candidates[0]?.status

    // chain 対象は detached なので少し待つ。非 0 終了でも検知は成立している。
    const chainDeadline = Date.now() + CHAIN_POLL_TIMEOUT_MS
    while (!existsSync(chainMarker) && Date.now() < chainDeadline) {
      await sleep(CANDIDATE_POLL_INTERVAL_MS)
    }
    report.chainedNotifyCalled = existsSync(chainMarker)
    if (report.chainedNotifyCalled !== true) {
      report.result = 'FAIL: the chained notify was not started'
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }

    // ゼロ件・空入力: 対象外 event と空 payload では candidate が増えない
    const config = loadConfig({ TRACKER_DATA_DIR: dataDir, TRACKER_PORT: '4319' })
    for (const payload of [
      '',
      'not json',
      JSON.stringify({ type: 'agent-turn-start', cwd: projectDir }),
      JSON.stringify({ type: 'agent-turn-complete' }),
    ]) {
      await runAgentEvent({ agent: 'codex', input: 'argv', payload }, { config })
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

    report.userCodexConfigUnchanged = sha256OfFile(userCodexConfig) === userConfigBefore
    report.repoWorkingTreeUnchanged = repoStatus() === repoStatusBefore
    if (report.userCodexConfigUnchanged !== true || report.repoWorkingTreeUnchanged !== true) {
      report.result = 'FAIL: an isolated resource was modified'
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }

    // installer 経路 (install → doctor → repair → uninstall) を、利用者の実 config を
    // copy した temp HOME に対して実行する。実 file は読むだけ。
    const installerHome = mkdtempSync(join(tmpdir(), 'adpt-real-codex-home-'))
    try {
      mkdirSync(join(installerHome, '.codex'), { recursive: true })
      const copied = join(installerHome, '.codex', 'config.toml')
      if (existsSync(userCodexConfig)) {
        copyFileSync(userCodexConfig, copied)
      }
      const before = existsSync(copied) ? readFileSync(copied) : Buffer.alloc(0)
      const installerOptions = { home: installerHome, cliPath }

      report.installerInstall = setupAgents('install', installerOptions)[0]
      report.installerReadiness = inspectAgentIntegration(installerOptions).codexDetection
      report.installerRepair = setupAgents('repair', installerOptions)[0]
      report.installerUninstall = setupAgents('uninstall', installerOptions)[0]

      const after = existsSync(copied) ? readFileSync(copied) : Buffer.alloc(0)
      report.installerRestoredBytesEqual = after.equals(before)
      report.installerUsedTempHome =
        resolveIntegration(installerOptions).codexConfigPath.startsWith(installerHome)

      const okInstaller =
        (report.installerInstall as { ok?: boolean }).ok === true &&
        report.installerReadiness === 'ready' &&
        (report.installerRepair as { ok?: boolean }).ok === true &&
        (report.installerUninstall as { ok?: boolean }).ok === true &&
        report.installerRestoredBytesEqual === true &&
        report.installerUsedTempHome === true
      if (!okInstaller) {
        report.result = 'FAIL: the installer round trip over the real config copy failed'
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
        return 1
      }
    } finally {
      rmSync(installerHome, { recursive: true, force: true })
    }

    report.userCodexConfigStillUnchanged = sha256OfFile(userCodexConfig) === userConfigBefore
    if (report.userCodexConfigStillUnchanged !== true) {
      report.result = 'FAIL: the real user config changed'
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 1
    }

    report.result = 'PASS'
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
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
