import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'

export const CODEX_BLOCK_START = '# >>> ai-dev-progress-tracker managed notify >>>'
export const CODEX_BLOCK_END = '# <<< ai-dev-progress-tracker managed notify <<<'

export type AgentName = 'codex' | 'claude'

export type AgentReadiness =
  | 'ready'
  | 'not_installed'
  | 'stale'
  | 'conflict'
  | 'invalid_config'
  | 'hooks_disabled'

export interface AgentIntegrationOptions {
  /** テスト・実機scriptで temp HOME を差し替えるための seam。 */
  home?: string
  nodePath?: string
  cliPath?: string
}

export interface ResolvedIntegration {
  codexConfigPath: string
  claudeSettingsPath: string
  nodePath: string
  cliPath: string
}

export type AgentSetupOutcome =
  | { agent: AgentName; ok: true; state: 'installed' | 'updated' | 'unchanged' | 'removed' }
  | { agent: AgentName; ok: false; code: string }

/** setup 時点の絶対 path を user 設定へ書き込む (DESIGN: repository移動後は --repair)。 */
function defaultCliPath(): string {
  return resolve(fileURLToPath(new URL('../../cli/index.js', import.meta.url)))
}

/** agent-event が起動する server entry。CLI と同じ build tree を指す。 */
export function defaultServerEntry(): string {
  return resolve(fileURLToPath(new URL('../index.js', import.meta.url)))
}

export function resolveIntegration(options: AgentIntegrationOptions = {}): ResolvedIntegration {
  const home = options.home ?? homedir()
  return {
    codexConfigPath: resolve(home, '.codex', 'config.toml'),
    claudeSettingsPath: resolve(home, '.claude', 'settings.json'),
    nodePath: options.nodePath ?? process.execPath,
    cliPath: options.cliPath ?? defaultCliPath(),
  }
}

export function codexNotifyArgv(nodePath: string, cliPath: string): string[] {
  return [nodePath, cliPath, 'agent-event', '--agent', 'codex', '--input', 'argv']
}

export function claudeHookArgs(cliPath: string): string[] {
  return [cliPath, 'agent-event', '--agent', 'claude', '--input', 'stdin']
}

interface ClaudeHookEntry {
  type: 'command'
  command: string
  args: string[]
  timeout: number
}

interface ClaudeHookGroup {
  matcher: string
  hooks: ClaudeHookEntry[]
}

function claudeTrackerGroup(nodePath: string, cliPath: string): ClaudeHookGroup {
  return {
    matcher: '*',
    hooks: [{ type: 'command', command: nodePath, args: claudeHookArgs(cliPath), timeout: 5 }],
  }
}

function sameStrings(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && JSON.stringify(a) === JSON.stringify(b)
}

function readTextOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

// --- Codex --------------------------------------------------------------

export type CodexConfigState = 'absent' | 'managed' | 'stale' | 'conflict' | 'invalid'

export function inspectCodexConfig(
  text: string,
  expectedArgv: readonly string[],
): CodexConfigState {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(text) as Record<string, unknown>
  } catch {
    return 'invalid'
  }
  const notify = parsed.notify
  const hasManagedBlock = text.includes(CODEX_BLOCK_START) && text.includes(CODEX_BLOCK_END)
  if (notify === undefined) {
    return 'absent'
  }
  if (!hasManagedBlock) {
    return 'conflict'
  }
  return sameStrings(notify, expectedArgv) ? 'managed' : 'stale'
}

function managedCodexBlock(argv: readonly string[]): string {
  const rendered = argv.map((value) => JSON.stringify(value)).join(', ')
  return `${CODEX_BLOCK_START}\nnotify = [${rendered}]\n${CODEX_BLOCK_END}\n`
}

function removeManagedCodexBlock(text: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(CODEX_BLOCK_START)
  const end = lines.indexOf(CODEX_BLOCK_END)
  if (start === -1 || end === -1 || end < start) {
    return text
  }
  lines.splice(start, end - start + 1)
  return lines.join('\n')
}

/** managed block は最初の table header より前 (= top-level) へ入れる。既存行は動かさない。 */
function insertManagedCodexBlock(text: string, block: string): string {
  const lines = text.split('\n')
  const firstTable = lines.findIndex((line) => line.trimStart().startsWith('['))
  if (firstTable === -1) {
    const base = text === '' || text.endsWith('\n') ? text : `${text}\n`
    return `${base}${block}`
  }
  lines.splice(firstTable, 0, ...block.trimEnd().split('\n'), '')
  return lines.join('\n')
}

export function applyCodexNotify(
  integration: ResolvedIntegration,
  mode: 'install' | 'uninstall',
): AgentSetupOutcome {
  const expected = codexNotifyArgv(integration.nodePath, integration.cliPath)
  const text = readTextOrEmpty(integration.codexConfigPath)
  const state = inspectCodexConfig(text, expected)

  if (state === 'invalid') {
    return { agent: 'codex', ok: false, code: 'INVALID_AGENT_CONFIG' }
  }
  if (state === 'conflict') {
    // 既存 notify は上書きも chain もしない (DESIGN D006)。file は 1 byte も変えない。
    return mode === 'uninstall'
      ? { agent: 'codex', ok: true, state: 'unchanged' }
      : { agent: 'codex', ok: false, code: 'CODEX_NOTIFY_CONFLICT' }
  }

  if (mode === 'uninstall') {
    if (state === 'absent') {
      return { agent: 'codex', ok: true, state: 'unchanged' }
    }
    writeText(integration.codexConfigPath, removeManagedCodexBlock(text))
    return { agent: 'codex', ok: true, state: 'removed' }
  }

  if (state === 'managed') {
    return { agent: 'codex', ok: true, state: 'unchanged' }
  }
  const block = managedCodexBlock(expected)
  const next =
    state === 'stale'
      ? insertManagedCodexBlock(removeManagedCodexBlock(text), block)
      : insertManagedCodexBlock(text, block)
  writeText(integration.codexConfigPath, next)
  return { agent: 'codex', ok: true, state: state === 'stale' ? 'updated' : 'installed' }
}

// --- Claude Code --------------------------------------------------------

export type ClaudeSettingsState = 'absent' | 'managed' | 'stale' | 'invalid' | 'disabled'

interface ClaudeInspection {
  state: ClaudeSettingsState
  settings: Record<string, unknown>
}

function isTrackerGroup(group: unknown): boolean {
  if (group === null || typeof group !== 'object') {
    return false
  }
  const hooks = (group as { hooks?: unknown }).hooks
  if (!Array.isArray(hooks)) {
    return false
  }
  return hooks.some((hook) => {
    const args = (hook as { args?: unknown }).args
    return Array.isArray(args) && args.includes('agent-event') && args.includes('claude')
  })
}

function inspectClaudeSettingsInternal(text: string, expected: ClaudeHookGroup): ClaudeInspection {
  let settings: Record<string, unknown> = {}
  if (text.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { state: 'invalid', settings: {} }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'invalid', settings: {} }
    }
    settings = parsed as Record<string, unknown>
  }
  if (settings.disableAllHooks === true) {
    return { state: 'disabled', settings }
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>
  const groups = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []
  const tracker = groups.find(isTrackerGroup)
  if (tracker === undefined) {
    return { state: 'absent', settings }
  }
  return {
    state: JSON.stringify(tracker) === JSON.stringify(expected) ? 'managed' : 'stale',
    settings,
  }
}

export function inspectClaudeSettings(
  text: string,
  nodePath: string,
  cliPath: string,
): ClaudeSettingsState {
  return inspectClaudeSettingsInternal(text, claudeTrackerGroup(nodePath, cliPath)).state
}

export function applyClaudeHook(
  integration: ResolvedIntegration,
  mode: 'install' | 'uninstall',
): AgentSetupOutcome {
  const expected = claudeTrackerGroup(integration.nodePath, integration.cliPath)
  const text = readTextOrEmpty(integration.claudeSettingsPath)
  const { state, settings } = inspectClaudeSettingsInternal(text, expected)

  if (state === 'invalid') {
    return { agent: 'claude', ok: false, code: 'INVALID_AGENT_CONFIG' }
  }
  if (state === 'disabled') {
    return mode === 'uninstall'
      ? { agent: 'claude', ok: true, state: 'unchanged' }
      : { agent: 'claude', ok: false, code: 'CLAUDE_HOOKS_DISABLED' }
  }
  if (mode === 'install' && state === 'managed') {
    return { agent: 'claude', ok: true, state: 'unchanged' }
  }
  if (mode === 'uninstall' && state === 'absent') {
    return { agent: 'claude', ok: true, state: 'unchanged' }
  }

  // 未知 key も他の hook も保持したまま、tracker group だけを差し替える。
  const hooks = { ...((settings.hooks ?? {}) as Record<string, unknown>) }
  const groups = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : []
  const kept = groups.filter((group) => !isTrackerGroup(group))

  if (mode === 'uninstall') {
    if (kept.length > 0) {
      hooks.UserPromptSubmit = kept
    } else {
      delete hooks.UserPromptSubmit
    }
  } else {
    hooks.UserPromptSubmit = [...kept, expected]
  }

  if (Object.keys(hooks).length > 0) {
    settings.hooks = hooks
  } else {
    delete settings.hooks
  }
  writeText(integration.claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  return {
    agent: 'claude',
    ok: true,
    state: mode === 'uninstall' ? 'removed' : state === 'stale' ? 'updated' : 'installed',
  }
}

// --- setup / inspect ----------------------------------------------------

export function setupAgents(
  mode: 'install' | 'repair' | 'uninstall',
  options: AgentIntegrationOptions = {},
): AgentSetupOutcome[] {
  const integration = resolveIntegration(options)
  const action = mode === 'uninstall' ? 'uninstall' : 'install'
  return [applyCodexNotify(integration, action), applyClaudeHook(integration, action)]
}

export interface AgentIntegrationStatus {
  codexDetection: AgentReadiness
  claudeDetection: AgentReadiness
}

const READINESS: Record<string, AgentReadiness> = {
  managed: 'ready',
  absent: 'not_installed',
  stale: 'stale',
  conflict: 'conflict',
  invalid: 'invalid_config',
  disabled: 'hooks_disabled',
}

/** doctor / system status 用。raw config 内容や auth 出力は返さない。 */
export function inspectAgentIntegration(
  options: AgentIntegrationOptions = {},
): AgentIntegrationStatus {
  const integration = resolveIntegration(options)
  const codex = inspectCodexConfig(
    readTextOrEmpty(integration.codexConfigPath),
    codexNotifyArgv(integration.nodePath, integration.cliPath),
  )
  const claude = inspectClaudeSettings(
    readTextOrEmpty(integration.claudeSettingsPath),
    integration.nodePath,
    integration.cliPath,
  )
  return {
    codexDetection: READINESS[codex] ?? 'invalid_config',
    claudeDetection: READINESS[claude] ?? 'invalid_config',
  }
}
