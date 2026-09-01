import { type RunResult, runProcess } from '../../server/adapters/process-runner.js'
import { checkVersion, VERSION_REQUIREMENTS, type VersionRequirement } from '../../server/config.js'

const CLI_TIMEOUT_MS = 20_000
const CHATGPT_MARKER = /Logged in using ChatGPT/i
const API_KEY_MARKER = /API key/i

interface CheckOutcome {
  name: string
  ok: boolean
  detail: string
}

async function checkCliVersion(
  name: string,
  command: string,
  args: readonly string[],
  requirement: VersionRequirement,
): Promise<CheckOutcome> {
  let result: RunResult
  try {
    result = await runProcess(command, args, { timeoutMs: CLI_TIMEOUT_MS })
  } catch {
    return { name, ok: false, detail: `${command} not found` }
  }
  if (result.timedOut) {
    return { name, ok: false, detail: 'version check timed out' }
  }
  const raw = `${result.stdout}\n${result.stderr}`.trim()
  const check = checkVersion(raw, requirement)
  if (check.ok) {
    return { name, ok: true, detail: check.version.join('.') }
  }
  return { name, ok: false, detail: check.code }
}

async function checkGhAuth(): Promise<CheckOutcome> {
  const name = 'GitHub auth'
  try {
    const result = await runProcess(
      'gh',
      ['auth', 'status', '--active', '--hostname', 'github.com'],
      { timeoutMs: CLI_TIMEOUT_MS },
    )
    // raw出力はlog/表示しない。
    if (result.timedOut) {
      return { name, ok: false, detail: 'gh auth check timed out' }
    }
    return result.code === 0
      ? { name, ok: true, detail: 'authenticated' }
      : { name, ok: false, detail: 'GITHUB_AUTH_REQUIRED' }
  } catch {
    return { name, ok: false, detail: 'gh not found' }
  }
}

async function checkCodexAuth(): Promise<CheckOutcome> {
  const name = 'Codex auth'
  try {
    const result = await runProcess('codex', ['login', 'status'], { timeoutMs: CLI_TIMEOUT_MS })
    // raw出力はlog/表示しない。分類結果だけを返す。
    if (result.timedOut) {
      return { name, ok: false, detail: 'codex auth check timed out' }
    }
    const combined = `${result.stdout}\n${result.stderr}`
    if (CHATGPT_MARKER.test(combined)) {
      return { name, ok: true, detail: 'ChatGPT' }
    }
    if (API_KEY_MARKER.test(combined)) {
      return { name, ok: false, detail: 'AI_AUTH_NOT_CHATGPT' }
    }
    return { name, ok: false, detail: 'CODEX_AUTH_REQUIRED' }
  } catch {
    return { name, ok: false, detail: 'codex not found' }
  }
}

/** すべての検査がpassなら0、いずれか失敗で1を返す。 */
export async function runDoctor(): Promise<number> {
  const nodeCheck = checkVersion(process.versions.node, VERSION_REQUIREMENTS.node)
  const outcomes: CheckOutcome[] = [
    {
      name: 'Node.js',
      ok: nodeCheck.ok,
      detail: nodeCheck.ok ? nodeCheck.version.join('.') : nodeCheck.code,
    },
    await checkCliVersion('Git', 'git', ['--version'], VERSION_REQUIREMENTS.git),
    await checkCliVersion('GitHub CLI', 'gh', ['--version'], VERSION_REQUIREMENTS.gh),
    await checkGhAuth(),
    await checkCliVersion('Codex CLI', 'codex', ['--version'], VERSION_REQUIREMENTS.codex),
    await checkCodexAuth(),
  ]

  for (const outcome of outcomes) {
    process.stdout.write(`${outcome.ok ? 'OK  ' : 'FAIL'} ${outcome.name}: ${outcome.detail}\n`)
  }

  return outcomes.every((outcome) => outcome.ok) ? 0 : 1
}
