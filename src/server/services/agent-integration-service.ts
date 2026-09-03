import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
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
 * top-level `notify = ...` の raw 範囲 (改行を含まない) を返す。table header 以降は対象にしない。
 * managed block 内かどうかは問わない (所有権判定は readManagedBlock が行い、そこで
 * 「top-level notify が block の中にあること」を確認する)。
 * 求めた範囲を単独で parse し直し、値が一致しない場合は null を返す (誤検出を残さない)。
 */
export function findTopLevelNotifyRange(text: string, expectedValue: unknown): TextRange | null {
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
    if (topLevel && key === 'notify') {
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

/** managed argv の `--chain <json>`。「無い」と「壊れている」を区別する。 */
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
 * argv が tracker 自身の notify handler かを内容で判定する。
 * setup 時点の絶対 path とは比較しない (repository 移動後の `--repair` も所有と認める) が、
 * 実行体が Node であること・CLI が絶対 path の `.../cli/index.js` であることまでは要求する。
 */
export function isTrackerNotifyArgv(argv: readonly string[] | null): boolean {
  if (argv === null || argv.length < 7) {
    return false
  }
  const [nodePath, cliPath, command, agentFlag, agent, inputFlag, input, ...rest] = argv
  if (nodePath === undefined || cliPath === undefined) {
    return false
  }
  const nodeName = basename(nodePath).toLowerCase()
  if (nodeName !== 'node' && nodeName !== 'node.exe') {
    return false
  }
  if (!isAbsolute(cliPath) || !/[\\/]cli[\\/]index\.js$/.test(cliPath)) {
    return false
  }
  if (
    command !== 'agent-event' ||
    agentFlag !== '--agent' ||
    agent !== 'codex' ||
    inputFlag !== '--input' ||
    input !== 'argv'
  ) {
    return false
  }
  // 末尾は「無い」か `--chain <json>` だけ。
  if (rest.length === 0) {
    return true
  }
  return rest.length === 2 && rest[0] === '--chain' && readChainArgv(argv).kind === 'ok'
}

// --- managed block の識別と所有権判定 ---------------------------------------
//
// 「tracker が書いた block か」を 1 か所で決める。判定材料は block 自身だけで、
// file 全体の parse 結果 (top-level notify) は所有権判定に使わない。
// 満たすべき条件:
//   1. 開始/終了 marker が **行全体** として 1 組だけ存在する (marker 行に他の文字を許さない)
//   2. block の中身が「任意の `# previous-notify:` 1 行」+「TOML として `notify` だけを
//      定義する本文」であること
//   3. その `notify` が tracker 自身の argv 形であること
//   4. file の top-level `notify` assignment が、この block の範囲内にあること
//      (block が table の中にある / 別の場所に top-level notify がある構成を弾く)

/**
 * 範囲を行境界まで広げる。marker 行に他の文字 (行末コメント等) が残らないよう、
 * 置換対象は必ず行単位にする。退避もこの範囲の raw bytes で行う。
 */
export function expandToLineBounds(text: string, range: TextRange): TextRange {
  const LF = '\n'
  const CR = '\r'
  let start = range.start
  while (start > 0 && text[start - 1] !== LF) {
    start -= 1
  }
  let end = range.end
  while (end < text.length && text[end] !== LF) {
    end += 1
  }
  // CRLF の CR は行の内容ではなく終端として扱う。
  if (end > start && text[end - 1] === CR) {
    end -= 1
  }
  return { start, end }
}

export interface ManagedBlockView {
  range: TextRange
  notifyArgv: string[]
  notifyRange: TextRange
  previousRaw: string | null
  chainArgv: string[] | null
}

export type ManagedBlockResult =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'owned'; view: ManagedBlockView }

function markerLineRegExp(marker: string): RegExp {
  // marker は行全体。前後の空白だけ許し、後ろに文字列が付くものは認めない。
  return new RegExp(`^[ \\t]*${escapeRegExp(marker)}[ \\t]*$`)
}

/** file 全体を走査し、line-exact な marker 行の位置を集める。 */
function findMarkerLines(text: string): { starts: number[]; ends: number[]; lines: string[] } {
  const lines = text.split('\n')
  const startRe = markerLineRegExp(CODEX_BLOCK_START)
  const endRe = markerLineRegExp(CODEX_BLOCK_END)
  const starts: number[] = []
  const ends: number[] = []
  lines.forEach((line, index) => {
    const value = line.replace(/\r$/, '')
    if (startRe.test(value)) {
      starts.push(index)
    }
    if (endRe.test(value)) {
      ends.push(index)
    }
  })
  return { starts, ends, lines }
}

function lineRangeToOffsets(lines: readonly string[], from: number, to: number): TextRange {
  let start = 0
  for (let index = 0; index < from; index += 1) {
    start += (lines[index]?.length ?? 0) + 1
  }
  let end = start
  for (let index = from; index <= to; index += 1) {
    end += (lines[index]?.length ?? 0) + 1
  }
  // 末尾 marker 行の改行は範囲へ含めない。CRLF の CR も終端側として扱う
  // (block を置換しても元の改行がそのまま残るようにするため)。
  end -= 1
  if ((lines[to] ?? '').endsWith('\r')) {
    end -= 1
  }
  return { start, end }
}

/** managed block を 1 か所で識別し、所有権まで判定する。 */
export function readManagedBlock(text: string, topLevelNotify: unknown): ManagedBlockResult {
  const { starts, ends, lines } = findMarkerLines(text)
  const hasAnyMarkerText = text.includes(CODEX_BLOCK_START) || text.includes(CODEX_BLOCK_END)

  if (starts.length === 0 && ends.length === 0) {
    // marker 文字列が行全体としては無いのに部分一致で現れる = 判別できない。
    return hasAnyMarkerText
      ? { kind: 'invalid', reason: 'a marker string appears outside a marker line' }
      : { kind: 'none' }
  }
  if (starts.length !== 1 || ends.length !== 1) {
    return { kind: 'invalid', reason: 'the managed block markers are not a single pair' }
  }
  const [start] = starts
  const [end] = ends
  if (start === undefined || end === undefined || end <= start) {
    return { kind: 'invalid', reason: 'the managed block markers are not in order' }
  }
  // marker 文字列が block 以外の場所にも現れるなら判別できない。
  const blockLines = lines.slice(start, end + 1)
  const outside = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n')
  if (outside.includes(CODEX_BLOCK_START) || outside.includes(CODEX_BLOCK_END)) {
    return { kind: 'invalid', reason: 'a marker string appears outside the managed block' }
  }

  const body = blockLines.slice(1, -1).map((line) => line.replace(/\r$/, ''))
  const previousLines = body.filter((line) => line.startsWith(PREVIOUS_NOTIFY_PREFIX))
  if (previousLines.length > 1) {
    return { kind: 'invalid', reason: 'the managed block has more than one previous-notify' }
  }
  const tomlBody = body.filter((line) => !line.startsWith(PREVIOUS_NOTIFY_PREFIX)).join('\n')

  // block の中身だけを TOML として読む。file 全体の値は使わない。
  let blockParsed: Record<string, unknown>
  try {
    blockParsed = parseToml(tomlBody) as Record<string, unknown>
  } catch {
    return { kind: 'invalid', reason: 'the managed block body is not valid TOML' }
  }
  const keys = Object.keys(blockParsed)
  if (keys.length !== 1 || keys[0] !== 'notify') {
    return { kind: 'invalid', reason: 'the managed block body defines something other than notify' }
  }
  const notifyArgv = asStringArray(blockParsed.notify)
  if (!isTrackerNotifyArgv(notifyArgv) || notifyArgv === null) {
    return {
      kind: 'invalid',
      reason: 'the notify inside the managed block is not the tracker handler',
    }
  }

  const range = lineRangeToOffsets(lines, start, end)

  // file の top-level notify assignment が block の中にあること。
  // (block が table の中にある / 別の top-level notify がある構成を弾く)
  const topLevelRange = findTopLevelNotifyRange(text, topLevelNotify)
  if (
    topLevelRange === null ||
    topLevelRange.start < range.start ||
    topLevelRange.end > range.end ||
    JSON.stringify(topLevelNotify) !== JSON.stringify(notifyArgv)
  ) {
    return {
      kind: 'invalid',
      reason: 'the managed block is not the top-level notify of this config',
    }
  }

  const previous = decodePreviousNotify(blockLines.join('\n'))
  if (!previous.ok) {
    return { kind: 'invalid', reason: previous.reason ?? 'previous-notify is unusable' }
  }
  const chain = readChainArgv(notifyArgv)
  if (chain.kind === 'invalid') {
    return { kind: 'invalid', reason: 'the chained argv is not valid JSON' }
  }
  const chainArgv = chain.kind === 'ok' ? chain.argv : null

  // 退避値と --chain の対応。片方だけある / 中身が食い違うものは復元先を保証できない。
  if (previous.raw !== null) {
    const restored = (() => {
      try {
        return asStringArray((parseToml(previous.raw) as Record<string, unknown>).notify)
      } catch {
        return null
      }
    })()
    if (chainArgv === null || JSON.stringify(restored) !== JSON.stringify(chainArgv)) {
      return { kind: 'invalid', reason: 'previous-notify does not match the chained argv' }
    }
  } else if (chainArgv !== null) {
    return { kind: 'invalid', reason: 'chained argv has no saved previous-notify' }
  }

  return {
    kind: 'owned',
    view: { range, notifyArgv, notifyRange: topLevelRange, previousRaw: previous.raw, chainArgv },
  }
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
  // BOM は parse 前に外す。以降の offset はすべて BOM を除いた本文基準。
  const { body: text } = splitBom(raw)
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(text) as Record<string, unknown>
  } catch {
    return { state: 'invalid', chainArgv: null, previousRaw: null }
  }
  const notify = parsed.notify
  const block = readManagedBlock(text, notify)

  if (block.kind === 'invalid') {
    // 所有権を確認できない config は 1 byte も書かない。
    return { state: 'corrupt', chainArgv: null, previousRaw: null, reason: block.reason }
  }

  if (block.kind === 'none') {
    if (notify === undefined) {
      return { state: 'absent', chainArgv: null, previousRaw: null }
    }
    // 既存 notify は削除せず chain する (DESIGN v2.2 D006)。
    const argv = asStringArray(notify)
    if (argv === null) {
      return { state: 'conflict', chainArgv: null, previousRaw: null }
    }
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

  const { view } = block
  const expected = withChain(expectedArgv, view.chainArgv)
  return {
    state: sameStrings(view.notifyArgv, expected) ? 'managed' : 'stale',
    chainArgv: view.chainArgv,
    previousRaw: view.previousRaw,
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

  if (inspection.state === 'invalid' || inspection.state === 'corrupt') {
    // TOML が壊れている / 所有権を確認できない。復元先を保証できないので何も書かない。
    return { agent: 'codex', ok: false, code: 'INVALID_AGENT_CONFIG' }
  }
  if (inspection.state === 'conflict') {
    // string 配列でない notify は安全に chain できないので触らない。
    return mode === 'uninstall'
      ? { agent: 'codex', ok: true, state: 'unchanged' }
      : { agent: 'codex', ok: false, code: 'CODEX_NOTIFY_CONFLICT' }
  }

  // ここから先は「所有している block がある」か「無い」かのどちらかしかない。
  const owned = (() => {
    let parsedNotify: unknown
    try {
      parsedNotify = (parseToml(text) as Record<string, unknown>).notify
    } catch {
      return null
    }
    const block = readManagedBlock(text, parsedNotify)
    return block.kind === 'owned' ? block.view : null
  })()

  if (mode === 'uninstall') {
    if (owned === null) {
      return { agent: 'codex', ok: true, state: 'unchanged' }
    }
    // 退避してあった元の assignment を、同じ位置へ byte 単位で書き戻す。
    // 退避が無い (chain していない) 場合は block と直後の改行ごと取り除く。
    const next =
      owned.previousRaw === null
        ? text.slice(0, owned.range.start) + text.slice(consumeEol(text, owned.range.end))
        : text.slice(0, owned.range.start) + owned.previousRaw + text.slice(owned.range.end)
    write(next)
    return { agent: 'codex', ok: true, state: 'removed' }
  }

  if (inspection.state === 'managed') {
    return { agent: 'codex', ok: true, state: 'unchanged' }
  }

  if (inspection.state === 'stale' && owned !== null) {
    // chain 情報と退避行は保持したまま tracker block だけ作り直す。
    const block = managedCodexBlock(withChain(base, owned.chainArgv), owned.previousRaw, eol)
    write(text.slice(0, owned.range.start) + block + text.slice(owned.range.end))
    return { agent: 'codex', ok: true, state: 'updated' }
  }

  if (inspection.state === 'chainable') {
    const parsedNotify = (parseToml(text) as Record<string, unknown>).notify
    const range = findTopLevelNotifyRange(text, parsedNotify)
    if (range === null) {
      return { agent: 'codex', ok: false, code: 'INVALID_AGENT_CONFIG' }
    }
    // 行境界まで広げて退避する (行末コメント・空白も含めて byte 一致で戻す)。
    const lineRange = expandToLineBounds(text, range)
    const previousRaw = text.slice(lineRange.start, lineRange.end)
    const block = managedCodexBlock(withChain(base, inspection.chainArgv), previousRaw, eol)
    write(text.slice(0, lineRange.start) + block + text.slice(lineRange.end))
    return { agent: 'codex', ok: true, state: 'chained' }
  }

  // absent: 本文の先頭へ `block + 改行1つ` を挿入する。常に行頭なので
  // uninstall が同じ範囲を取り除くだけで byte 一致に戻る。
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
