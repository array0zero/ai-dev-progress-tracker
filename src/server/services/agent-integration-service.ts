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
  | {
      agent: AgentName
      ok: true
      state: 'installed' | 'chained' | 'updated' | 'unchanged' | 'removed'
    }
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

export type CodexConfigState = 'absent' | 'managed' | 'stale' | 'chainable' | 'conflict' | 'invalid'

const PREVIOUS_NOTIFY_PREFIX = '# previous-notify: '

export interface CodexInspection {
  state: CodexConfigState
  /** chain 対象の既存 argv (chainable / managed with chain のとき)。 */
  chainArgv: string[] | null
  /** 退避済みの元 raw 行 (managed のとき)。 */
  previousRaw: string | null
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

/** managed block の範囲 [start, end] を返す。無ければ null。 */
function managedBlockRange(lines: readonly string[]): [number, number] | null {
  const start = lines.indexOf(CODEX_BLOCK_START)
  const end = lines.indexOf(CODEX_BLOCK_END)
  return start === -1 || end === -1 || end < start ? null : [start, end]
}

function decodePreviousRaw(lines: readonly string[]): string | null {
  const line = lines.find((value) => value.startsWith(PREVIOUS_NOTIFY_PREFIX))
  if (line === undefined) {
    return null
  }
  try {
    return Buffer.from(line.slice(PREVIOUS_NOTIFY_PREFIX.length), 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * top-level `notify = ...` の raw 行範囲を返す (配列が複数行に跨る場合も含む)。
 * managed block 内の行は対象外。
 */
function findNotifyAssignment(lines: readonly string[]): [number, number] | null {
  const managed = managedBlockRange(lines)
  for (let index = 0; index < lines.length; index += 1) {
    if (managed !== null && index >= managed[0] && index <= managed[1]) {
      continue
    }
    const line = lines[index] ?? ''
    if (!/^\s*notify\s*=/.test(line)) {
      continue
    }
    let depth = 0
    for (let end = index; end < lines.length; end += 1) {
      const text = lines[end] ?? ''
      for (const char of text) {
        if (char === '[') {
          depth += 1
        } else if (char === ']') {
          depth -= 1
        }
      }
      if (depth <= 0) {
        return [index, end]
      }
    }
    return [index, lines.length - 1]
  }
  return null
}

export function inspectCodexConfig(text: string, expectedArgv: readonly string[]): CodexInspection {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(text) as Record<string, unknown>
  } catch {
    return { state: 'invalid', chainArgv: null, previousRaw: null }
  }
  const lines = text.split('\n')
  const notify = parsed.notify
  const managed = managedBlockRange(lines) !== null

  if (notify === undefined) {
    return { state: 'absent', chainArgv: null, previousRaw: null }
  }
  if (!managed) {
    // 既存 notify は削除せず chain する (DESIGN v2.2 D006)。
    const argv = asStringArray(notify)
    return argv === null
      ? { state: 'conflict', chainArgv: null, previousRaw: null }
      : { state: 'chainable', chainArgv: argv, previousRaw: null }
  }

  const previousRaw = decodePreviousRaw(lines)
  const chainArgv = readChainArgv(asStringArray(notify) ?? [])
  const expected = withChain(expectedArgv, chainArgv)
  return {
    state: sameStrings(notify, expected) ? 'managed' : 'stale',
    chainArgv,
    previousRaw,
  }
}

/** managed argv から `--chain <json>` を取り出す。 */
function readChainArgv(argv: readonly string[]): string[] | null {
  const index = argv.indexOf('--chain')
  if (index === -1) {
    return null
  }
  try {
    return asStringArray(JSON.parse(argv[index + 1] ?? ''))
  } catch {
    return null
  }
}

export function withChain(argv: readonly string[], chainArgv: readonly string[] | null): string[] {
  return chainArgv === null || chainArgv.length === 0
    ? [...argv]
    : [...argv, '--chain', JSON.stringify(chainArgv)]
}

function managedCodexBlock(argv: readonly string[], previousRaw: string | null): string {
  const rendered = argv.map((value) => JSON.stringify(value)).join(', ')
  const previousLine =
    previousRaw === null
      ? ''
      : `${PREVIOUS_NOTIFY_PREFIX}${Buffer.from(previousRaw, 'utf8').toString('base64')}\n`
  return `${CODEX_BLOCK_START}\n${previousLine}notify = [${rendered}]\n${CODEX_BLOCK_END}\n`
}

function removeManagedCodexBlock(text: string): string {
  const lines = text.split('\n')
  const range = managedBlockRange(lines)
  if (range === null) {
    return text
  }
  lines.splice(range[0], range[1] - range[0] + 1)
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

/** 既存 notify の raw 行を managed block へ置き換える。位置は元の行のまま。 */
function replaceNotifyAssignment(
  text: string,
  block: string,
): { next: string; raw: string } | null {
  const lines = text.split('\n')
  const range = findNotifyAssignment(lines)
  if (range === null) {
    return null
  }
  const raw = lines.slice(range[0], range[1] + 1).join('\n')
  lines.splice(range[0], range[1] - range[0] + 1, ...block.trimEnd().split('\n'))
  return { next: lines.join('\n'), raw }
}

export function applyCodexNotify(
  integration: ResolvedIntegration,
  mode: 'install' | 'uninstall',
): AgentSetupOutcome {
  const base = codexNotifyArgv(integration.nodePath, integration.cliPath)
  const text = readTextOrEmpty(integration.codexConfigPath)
  const inspection = inspectCodexConfig(text, base)

  if (inspection.state === 'invalid') {
    return { agent: 'codex', ok: false, code: 'INVALID_AGENT_CONFIG' }
  }
  if (inspection.state === 'conflict') {
    // string 配列でない notify は安全に chain できないので触らない。
    return mode === 'uninstall'
      ? { agent: 'codex', ok: true, state: 'unchanged' }
      : { agent: 'codex', ok: false, code: 'CODEX_NOTIFY_CONFLICT' }
  }

  if (mode === 'uninstall') {
    if (inspection.state === 'absent' || inspection.state === 'chainable') {
      return { agent: 'codex', ok: true, state: 'unchanged' }
    }
    // 退避してあった元の raw 行をそのまま書き戻す。
    const removed = removeManagedCodexBlock(text)
    const restored =
      inspection.previousRaw === null
        ? removed
        : insertManagedCodexBlock(removed, `${inspection.previousRaw}\n`)
    writeText(integration.codexConfigPath, restored)
    return { agent: 'codex', ok: true, state: 'removed' }
  }

  if (inspection.state === 'managed') {
    return { agent: 'codex', ok: true, state: 'unchanged' }
  }

  if (inspection.state === 'chainable') {
    const block = managedCodexBlock(withChain(base, inspection.chainArgv), null)
    const replaced = replaceNotifyAssignment(text, block)
    if (replaced === null) {
      return { agent: 'codex', ok: false, code: 'INVALID_AGENT_CONFIG' }
    }
    // raw 行を退避してから block を確定させる (復元用)。
    const withPrevious = replaceNotifyAssignment(
      text,
      managedCodexBlock(withChain(base, inspection.chainArgv), replaced.raw),
    )
    if (withPrevious === null) {
      return { agent: 'codex', ok: false, code: 'INVALID_AGENT_CONFIG' }
    }
    writeText(integration.codexConfigPath, withPrevious.next)
    return { agent: 'codex', ok: true, state: 'chained' }
  }

  // absent / stale: chain 情報と退避行は保持したまま tracker block だけ作り直す。
  const block = managedCodexBlock(withChain(base, inspection.chainArgv), inspection.previousRaw)
  const next =
    inspection.state === 'stale'
      ? insertManagedCodexBlock(removeManagedCodexBlock(text), block)
      : insertManagedCodexBlock(text, block)
  writeText(integration.codexConfigPath, next)
  return { agent: 'codex', ok: true, state: inspection.state === 'stale' ? 'updated' : 'installed' }
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
  // 既存 notify があるだけの状態は chain 待ちなので「未導入」と同じ扱いにする。
  chainable: 'not_installed',
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
  ).state
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
