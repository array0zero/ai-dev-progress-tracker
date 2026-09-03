import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/** テスト用 seam: temp file への書き込み直後に失敗を注入する。 */
export interface WriteFaults {
  afterTempWrite?: () => void
}

let writeFaults: WriteFaults = {}

export function setWriteFaultsForTest(faults: WriteFaults): void {
  writeFaults = faults
}

/**
 * temp file へ完全に書いてから内容を読み直して検証し、atomic rename で置き換える。
 * 途中で失敗しても元 file は 1 byte も変わらない (指摘3)。
 */
export function writeConfigAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tracker-tmp-${process.pid}`
  try {
    writeFileSync(temp, text, 'utf8')
    writeFaults.afterTempWrite?.()
    if (readFileSync(temp, 'utf8') !== text) {
      throw new Error('temp config verification failed')
    }
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) {
      rmSync(temp, { force: true })
    }
  }
}

function writeText(path: string, text: string): void {
  writeConfigAtomically(path, text)
}

// --- Codex --------------------------------------------------------------

export type CodexConfigState =
  | 'absent'
  | 'managed'
  | 'stale'
  | 'chainable'
  | 'conflict'
  | 'corrupt'
  | 'invalid'

const PREVIOUS_NOTIFY_PREFIX = '# previous-notify: '

export interface CodexInspection {
  state: CodexConfigState
  /** chain 対象の既存 argv (chainable / managed with chain のとき)。 */
  chainArgv: string[] | null
  /** 退避済みの元 assignment の raw bytes (managed のとき)。 */
  previousRaw: string | null
  /** state=corrupt の理由 (log / doctor 用。config 本文は含めない)。 */
  reason?: string
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

const BOM = '﻿'

/** UTF-8 BOM を本文から切り離す。TOML parser は BOM 付き文字列を受け付けない。 */
export function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: '', body: text }
}

/** file が使っている改行。混在時は最初に現れたものへ合わせる。 */
function detectEol(text: string): string {
  return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text.replace(/\r\n/g, '')) ? '\r\n' : '\n'
}

// --- TOML を意識した範囲検出 ------------------------------------------------
//
// 文字列 (basic / literal / multi-line) と comment の中の `[` `]` `#` を値の
// 区切りとして誤読しないため、単純な行分割ではなく文字走査で範囲を求める。

function skipString(text: string, index: number): number {
  const quote = text[index]
  if (quote === undefined) {
    return index
  }
  const triple = text.startsWith(quote.repeat(3), index)
  if (triple) {
    const close = text.indexOf(quote.repeat(3), index + 3)
    return close === -1 ? text.length : close + 3
  }
  let i = index + 1
  while (i < text.length) {
    const char = text[i]
    if (char === '\\' && quote === '"') {
      i += 2
      continue
    }
    if (char === quote) {
      return i + 1
    }
    if (char === '\n') {
      // 未終端の 1 行文字列。parse 済みの config では起きないが安全側で止める。
      return i
    }
    i += 1
  }
  return text.length
}

function skipComment(text: string, index: number): number {
  const end = text.indexOf('\n', index)
  return end === -1 ? text.length : end
}

/** `=` の直後から値の終端 (exclusive) を返す。array は対応する `]` まで。 */
function scanValueEnd(text: string, index: number): number {
  let i = index
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i += 1
  }
  if (text[i] !== '[') {
    // scalar: 行末まで (文字列内の `#` は comment として扱わない)
    while (i < text.length) {
      const char = text[i]
      if (char === '\n') {
        return i
      }
      if (char === '"' || char === "'") {
        i = skipString(text, i)
        continue
      }
      if (char === '#') {
        return i
      }
      i += 1
    }
    return text.length
  }

  let depth = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '"' || char === "'") {
      i = skipString(text, i)
      continue
    }
    if (char === '#') {
      i = skipComment(text, i)
      continue
    }
    if (char === '[') {
      depth += 1
    } else if (char === ']') {
      depth -= 1
      if (depth === 0) {
        return i + 1
      }
    }
    i += 1
  }
  return text.length
}

export interface TextRange {
  start: number
  end: number
}

/**
 * top-level `notify = ...` の raw 範囲 (改行を含まない) を返す。
 * table header 以降 / managed block 内は対象にしない。
 * 求めた範囲を単独で parse し直し、値が一致しない場合は null を返す (誤検出を残さない)。
 */
export function findTopLevelNotifyRange(text: string, expectedValue: unknown): TextRange | null {
  const managed = findManagedBlock(text)?.range ?? null
  let i = 0
  let topLevel = true

  while (i < text.length) {
    const char = text[i]
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      i += 1
      continue
    }
    if (char === '#') {
      i = skipComment(text, i)
      continue
    }
    if (char === '[') {
      // table header
      topLevel = false
      i = skipComment(text, i)
      continue
    }

    const keyStart = i
    let cursor = i
    while (cursor < text.length && text[cursor] !== '=' && text[cursor] !== '\n') {
      if (text[cursor] === '"' || text[cursor] === "'") {
        cursor = skipString(text, cursor)
        continue
      }
      cursor += 1
    }
    if (text[cursor] !== '=') {
      i = cursor + 1
      continue
    }
    const key = text.slice(keyStart, cursor).trim()
    const valueEnd = scanValueEnd(text, cursor + 1)
    const insideManaged = managed !== null && keyStart >= managed.start && keyStart < managed.end
    if (topLevel && key === 'notify' && !insideManaged) {
      const slice = text.slice(keyStart, valueEnd)
      try {
        const reparsed = parseToml(slice) as Record<string, unknown>
        if (JSON.stringify(reparsed.notify) === JSON.stringify(expectedValue)) {
          return { start: keyStart, end: valueEnd }
        }
      } catch {
        // 範囲がずれている。破壊しないため null を返す。
      }
      return null
    }
    i = valueEnd
  }
  return null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type ChainRead = { kind: 'none' } | { kind: 'ok'; argv: string[] } | { kind: 'invalid' }

/** managed argv の `--chain <json>`。「無い」と「壊れている」を区別する (review 指摘3)。 */
function readChainArgv(argv: readonly string[]): ChainRead {
  const index = argv.indexOf('--chain')
  if (index === -1) {
    return { kind: 'none' }
  }
  const raw = argv[index + 1]
  if (raw === undefined) {
    return { kind: 'invalid' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'invalid' }
  }
  const argvValue = asStringArray(parsed)
  return argvValue === null ? { kind: 'invalid' } : { kind: 'ok', argv: argvValue }
}

/**
 * argv が tracker の notify handler かどうかを内容で判定する (re-review 指摘1)。
 * setup 時点の絶対 path に依存させない (repository 移動後の repair も所有と見なす)。
 */
export function isTrackerNotifyArgv(argv: readonly string[] | null): boolean {
  if (argv === null || argv.length < 7) {
    return false
  }
  const [, cliPath, command, agentFlag, agent, inputFlag, input, ...rest] = argv
  if (
    cliPath === undefined ||
    !/[\\/]cli[\\/]index\.js$/.test(cliPath) ||
    command !== 'agent-event' ||
    agentFlag !== '--agent' ||
    agent !== 'codex' ||
    inputFlag !== '--input' ||
    input !== 'argv'
  ) {
    return false
  }
  // 末尾は「無い」か `--chain <json>` だけ。
  return rest.length === 0 || (rest.length === 2 && rest[0] === '--chain')
}

export interface ManagedBlock {
  range: TextRange
  /** marker 対で囲まれた中身が tracker block の形をしているか (review 指摘2)。 */
  valid: boolean
  previousEncoded: string | null
  notifyLine: string | null
}

/**
 * marker 対で囲まれた範囲を返す。marker 文字列の存在だけでは managed と認めず、
 * 中身が「任意の `# previous-notify:` 1 行 + `notify = [...]` 1 行」だけであることまで見る。
 */
export function findManagedBlock(text: string): ManagedBlock | null {
  const pattern = new RegExp(
    `^[ \\t]*${escapeRegExp(CODEX_BLOCK_START)}[\\s\\S]*?^[ \\t]*${escapeRegExp(CODEX_BLOCK_END)}`,
    'm',
  )
  const match = pattern.exec(text)
  if (match === null) {
    return null
  }
  const range = { start: match.index, end: match.index + match[0].length }
  const lines = match[0].split('\n').map((line) => line.replace(/\r$/, ''))
  const body = lines.slice(1, -1)

  let previousEncoded: string | null = null
  let notifyLine: string | null = null
  let valid = true
  for (const line of body) {
    if (line.trim() === '') {
      continue
    }
    if (line.startsWith(PREVIOUS_NOTIFY_PREFIX)) {
      if (previousEncoded !== null) {
        valid = false
        break
      }
      previousEncoded = line.slice(PREVIOUS_NOTIFY_PREFIX.length).trim()
      continue
    }
    if (/^notify\s*=\s*\[/.test(line)) {
      if (notifyLine !== null) {
        valid = false
        break
      }
      notifyLine = line
      continue
    }
    // tracker が書いた覚えのない行がある = 利用者のデータ。触らない。
    valid = false
    break
  }
  if (notifyLine === null) {
    valid = false
  }
  return { range, valid, previousEncoded, notifyLine }
}

/** marker が片方だけ / 壊れた形で存在するか。存在するなら書き込みを止める。 */
function hasStrayMarker(text: string, block: ManagedBlock | null): boolean {
  const hasStart = text.includes(CODEX_BLOCK_START)
  const hasEnd = text.includes(CODEX_BLOCK_END)
  if (!hasStart && !hasEnd) {
    return false
  }
  if (block === null || !block.valid) {
    return true
  }
  // marker が block の外にもある場合 (利用者のコメント等) は判別できない。
  const outside = text.slice(0, block.range.start) + text.slice(block.range.end)
  return outside.includes(CODEX_BLOCK_START) || outside.includes(CODEX_BLOCK_END)
}

function encodePrevious(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64')
}

export interface PreviousNotify {
  ok: boolean
  raw: string | null
  reason?: string
}

/**
 * 退避行を復号し、base64 の往復一致と TOML としての妥当性まで検証する。
 * 壊れていれば ok=false を返し、呼び出し側は破壊的操作を行わない。
 */
export function decodePreviousNotify(blockText: string): PreviousNotify {
  const line = blockText
    .split('\n')
    .map((value) => value.replace(/\r$/, ''))
    .find((value) => value.startsWith(PREVIOUS_NOTIFY_PREFIX))
  if (line === undefined) {
    return { ok: true, raw: null }
  }
  const encoded = line.slice(PREVIOUS_NOTIFY_PREFIX.length).trim()
  if (encoded === '') {
    return { ok: false, raw: null, reason: 'previous-notify is empty' }
  }
  const decoded = Buffer.from(encoded, 'base64')
  // Buffer.from は不正 base64 を黙って捨てるので、往復一致で検出する。
  if (decoded.toString('base64') !== encoded) {
    return { ok: false, raw: null, reason: 'previous-notify is not valid base64' }
  }
  const raw = decoded.toString('utf8')
  try {
    const reparsed = parseToml(raw) as Record<string, unknown>
    if (asStringArray(reparsed.notify) === null) {
      return { ok: false, raw: null, reason: 'previous-notify is not a notify string array' }
    }
  } catch {
    return { ok: false, raw: null, reason: 'previous-notify does not parse as TOML' }
  }
  return { ok: true, raw }
}

export function inspectCodexConfig(raw: string, expectedArgv: readonly string[]): CodexInspection {
  // BOM は parse 前に外す。以降の offset はすべて BOM を除いた本文基準 (re-review 指摘2)。
  const { body: text } = splitBom(raw)
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(text) as Record<string, unknown>
  } catch {
    return { state: 'invalid', chainArgv: null, previousRaw: null }
  }
  const notify = parsed.notify
  const block = findManagedBlock(text)

  // marker が壊れた形で存在する / block の外にもある場合は、どこまでが tracker の
  // 書いた範囲か判別できない。利用者データを消さないため書き込みを止める (review 指摘2)。
  if (hasStrayMarker(text, block)) {
    return {
      state: 'corrupt',
      chainArgv: null,
      previousRaw: null,
      reason: 'the managed block markers are not in the expected shape',
    }
  }

  if (block === null) {
    if (notify === undefined) {
      return { state: 'absent', chainArgv: null, previousRaw: null }
    }
    // 既存 notify は削除せず chain する (DESIGN v2.2 D006)。
    const argv = asStringArray(notify)
    if (argv === null) {
      return { state: 'conflict', chainArgv: null, previousRaw: null }
    }
    // 範囲を安全に特定できない config は触らない。
    if (findTopLevelNotifyRange(text, notify) === null) {
      return {
        state: 'corrupt',
        chainArgv: null,
        previousRaw: null,
        reason: 'could not locate the notify assignment safely',
      }
    }
    return { state: 'chainable', chainArgv: argv, previousRaw: null }
  }

  if (notify === undefined) {
    // block はあるのに top-level notify が読めない = 構造が想定外。
    return {
      state: 'corrupt',
      chainArgv: null,
      previousRaw: null,
      reason: 'the managed block does not provide a top-level notify',
    }
  }

  // marker の形だけでは所有権を判定できない。block 内の notify が tracker 自身の
  // handler でなければ利用者の設定なので触らない (re-review 指摘1)。
  if (!isTrackerNotifyArgv(asStringArray(notify))) {
    return {
      state: 'corrupt',
      chainArgv: null,
      previousRaw: null,
      reason: 'the notify inside the managed block is not the tracker handler',
    }
  }

  const previous = decodePreviousNotify(text.slice(block.range.start, block.range.end))
  const chain = readChainArgv(asStringArray(notify) ?? [])
  if (chain.kind === 'invalid') {
    // 「--chain が無い」と「--chain が壊れている」を区別する (review 指摘3)。
    return {
      state: 'corrupt',
      chainArgv: null,
      previousRaw: null,
      reason: 'the chained argv is not valid JSON',
    }
  }
  const chainArgv = chain.kind === 'ok' ? chain.argv : null
  if (!previous.ok) {
    return { state: 'corrupt', chainArgv, previousRaw: null, reason: previous.reason }
  }
  // 退避値と --chain の不一致は復元先が特定できないので破壊的操作を止める。
  if (previous.raw !== null) {
    const restoredArgv = (() => {
      try {
        return asStringArray((parseToml(previous.raw) as Record<string, unknown>).notify)
      } catch {
        return null
      }
    })()
    if (chainArgv === null || JSON.stringify(restoredArgv) !== JSON.stringify(chainArgv)) {
      return {
        state: 'corrupt',
        chainArgv,
        previousRaw: null,
        reason: 'previous-notify does not match the chained argv',
      }
    }
  } else if (chainArgv !== null) {
    return {
      state: 'corrupt',
      chainArgv,
      previousRaw: null,
      reason: 'chained argv has no saved previous-notify',
    }
  }

  const expected = withChain(expectedArgv, chainArgv)
  return {
    state: sameStrings(notify, expected) ? 'managed' : 'stale',
    chainArgv,
    previousRaw: previous.raw,
  }
}

export function withChain(argv: readonly string[], chainArgv: readonly string[] | null): string[] {
  return chainArgv === null || chainArgv.length === 0
    ? [...argv]
    : [...argv, '--chain', JSON.stringify(chainArgv)]
}

function managedCodexBlock(
  argv: readonly string[],
  previousRaw: string | null,
  eol: string,
): string {
  const rendered = argv.map((value) => JSON.stringify(value)).join(', ')
  const lines = [CODEX_BLOCK_START]
  if (previousRaw !== null) {
    lines.push(`${PREVIOUS_NOTIFY_PREFIX}${encodePrevious(previousRaw)}`)
  }
  lines.push(`notify = [${rendered}]`, CODEX_BLOCK_END)
  return lines.join(eol)
}

export function applyCodexNotify(
  integration: ResolvedIntegration,
  mode: 'install' | 'uninstall',
): AgentSetupOutcome {
  const base = codexNotifyArgv(integration.nodePath, integration.cliPath)
  const { bom, body: text } = splitBom(readTextOrEmpty(integration.codexConfigPath))
  const inspection = inspectCodexConfig(text, base)
  const eol = detectEol(text)
  // 書き戻すときに BOM を復元する。
  const write = (next: string): void =>
    writeConfigAtomically(integration.codexConfigPath, `${bom}${next}`)

  if (inspection.state === 'invalid') {
    return { agent: 'codex', ok: false, code: 'INVALID_AGENT_CONFIG' }
  }
  if (inspection.state === 'corrupt') {
    // 退避データが壊れている / 一致しない。復元先を保証できないので何も書かない。
    return { agent: 'codex', ok: false, code: 'INVALID_AGENT_CONFIG' }
  }
  if (inspection.state === 'conflict') {
    // string 配列でない notify は安全に chain できないので触らない。
    return mode === 'uninstall'
      ? { agent: 'codex', ok: true, state: 'unchanged' }
      : { agent: 'codex', ok: false, code: 'CODEX_NOTIFY_CONFLICT' }
  }

  const managed = findManagedBlock(text)?.range ?? null

  if (mode === 'uninstall') {
    if (inspection.state === 'absent' || inspection.state === 'chainable' || managed === null) {
      return { agent: 'codex', ok: true, state: 'unchanged' }
    }
    // 退避してあった元の assignment を、同じ位置へ byte 単位で書き戻す。
    // 退避が無い (chain していない) 場合は block と直後の改行ごと取り除く。
    const next =
      inspection.previousRaw === null
        ? text.slice(0, managed.start) + text.slice(consumeEol(text, managed.end))
        : text.slice(0, managed.start) + inspection.previousRaw + text.slice(managed.end)
    write(next)
    return { agent: 'codex', ok: true, state: 'removed' }
  }

  if (inspection.state === 'managed') {
    return { agent: 'codex', ok: true, state: 'unchanged' }
  }

  if (inspection.state === 'chainable') {
    const parsed = parseToml(text) as Record<string, unknown>
    const range = findTopLevelNotifyRange(text, parsed.notify)
    if (range === null) {
      return { agent: 'codex', ok: false, code: 'INVALID_AGENT_CONFIG' }
    }
    const raw = text.slice(range.start, range.end)
    const block = managedCodexBlock(withChain(base, inspection.chainArgv), raw, eol)
    write(text.slice(0, range.start) + block + text.slice(range.end))
    return { agent: 'codex', ok: true, state: 'chained' }
  }

  if (inspection.state === 'stale' && managed !== null) {
    // chain 情報と退避行は保持したまま tracker block だけ作り直す。
    const block = managedCodexBlock(
      withChain(base, inspection.chainArgv),
      inspection.previousRaw,
      eol,
    )
    write(text.slice(0, managed.start) + block + text.slice(managed.end))
    return { agent: 'codex', ok: true, state: 'updated' }
  }

  // absent: top-level の先頭 (= 最初の table header より前) へ block + 改行を挿入する。
  // 常に行頭へ入れて `block + 1 改行` だけを足すので、末尾改行の有無に関わらず
  // uninstall が同じ範囲を取り除いて byte 一致で戻せる (review 指摘1)。
  const block = managedCodexBlock(base, null, eol)
  write(`${block}${eol}${text}`)
  return { agent: 'codex', ok: true, state: 'installed' }
}

/** offset 直後の 1 改行を読み飛ばす (block 削除時に空行を残さないため)。 */
function consumeEol(text: string, offset: number): number {
  if (text.startsWith('\r\n', offset)) {
    return offset + 2
  }
  return text.startsWith('\n', offset) ? offset + 1 : offset
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
  // 退避データが壊れている config は ready ではない (指摘1)。
  corrupt: 'invalid_config',
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
