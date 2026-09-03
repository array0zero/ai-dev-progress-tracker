import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  claudeHookArgs,
  codexNotifyArgv,
  inspectAgentIntegration,
  resolveIntegration,
  setupAgents,
  setWriteFaultsForTest,
} from '../../src/server/services/agent-integration-service.js'

const NODE_PATH = 'D:/node/node.exe'
const CLI_PATH = 'D:/app/dist/cli/index.js'
const MOVED_CLI_PATH = 'D:/moved/dist/cli/index.js'

describe('agent integration installer', () => {
  let home: string

  const options = (cliPath = CLI_PATH) => ({ home, nodePath: NODE_PATH, cliPath })
  const codexPath = (): string => join(home, '.codex', 'config.toml')
  const claudePath = (): string => join(home, '.claude', 'settings.json')
  const readCodex = (): string => readFileSync(codexPath(), 'utf8')
  const readClaude = (): Record<string, unknown> =>
    JSON.parse(readFileSync(claudePath(), 'utf8')) as Record<string, unknown>

  function writeCodex(text: string): void {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(codexPath(), text, 'utf8')
  }

  function writeClaude(text: string): void {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(claudePath(), text, 'utf8')
  }

  function trackerGroups(): Array<Record<string, unknown>> {
    const hooks = readClaude().hooks as { UserPromptSubmit?: Array<Record<string, unknown>> }
    return (hooks.UserPromptSubmit ?? []).filter((group) => {
      const entries = group.hooks as Array<{ args?: string[] }>
      return entries.some((entry) => entry.args?.includes('agent-event') === true)
    })
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adpt-home-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('resolves user config paths under the given home', () => {
    const integration = resolveIntegration(options())
    expect(integration.codexConfigPath).toBe(join(home, '.codex', 'config.toml'))
    expect(integration.claudeSettingsPath).toBe(join(home, '.claude', 'settings.json'))
  })

  it('creates one Codex entry and one Claude entry from an empty home', () => {
    expect(setupAgents('install', options())).toEqual([
      { agent: 'codex', ok: true, state: 'installed' },
      { agent: 'claude', ok: true, state: 'installed' },
    ])

    const toml = readCodex()
    expect(toml).toContain(CODEX_BLOCK_START)
    expect(toml).toContain(CODEX_BLOCK_END)
    const rendered = codexNotifyArgv(NODE_PATH, CLI_PATH)
      .map((value) => JSON.stringify(value))
      .join(', ')
    expect(toml).toContain(`notify = [${rendered}]`)

    expect(trackerGroups()).toEqual([
      {
        matcher: '*',
        hooks: [
          { type: 'command', command: NODE_PATH, args: claudeHookArgs(CLI_PATH), timeout: 5 },
        ],
      },
    ])
    expect(inspectAgentIntegration(options())).toEqual({
      codexDetection: 'ready',
      claudeDetection: 'ready',
    })
  })

  it('initializes an empty TOML and an empty JSON settings file', () => {
    writeCodex('')
    writeClaude('')
    expect(setupAgents('install', options()).every((outcome) => outcome.ok)).toBe(true)
    expect(trackerGroups()).toHaveLength(1)
    expect(inspectAgentIntegration(options()).codexDetection).toBe('ready')
  })

  it('writes absolute paths that survive a filesystem read back', () => {
    setupAgents('install', options())
    const notifyLine = readCodex()
      .split('\n')
      .find((line) => line.startsWith('notify = '))
    expect(JSON.parse(notifyLine?.replace('notify = ', '') ?? '[]')).toEqual([
      NODE_PATH,
      CLI_PATH,
      'agent-event',
      '--agent',
      'codex',
      '--input',
      'argv',
    ])

    const entries = trackerGroups()[0]?.hooks as Array<{ command: string; args: string[] }>
    expect(entries[0]?.command).toBe(NODE_PATH)
    expect(entries[0]?.args[0]).toBe(CLI_PATH)
  })

  it('keeps the managed notify above the first table header', () => {
    writeCodex('model = "gpt-5.6-terra"\n\n[mcp_servers.demo]\ncommand = "demo"\n')
    setupAgents('install', options())
    const lines = readCodex().split('\n')
    expect(lines.indexOf(CODEX_BLOCK_START)).toBeLessThan(lines.indexOf('[mcp_servers.demo]'))
    expect(lines).toContain('model = "gpt-5.6-terra"')
    expect(lines).toContain('command = "demo"')
  })

  it('reports INVALID_AGENT_CONFIG and changes nothing for broken TOML', () => {
    const broken = 'notify = [unclosed\n'
    writeCodex(broken)
    expect(setupAgents('install', options())[0]).toEqual({
      agent: 'codex',
      ok: false,
      code: 'INVALID_AGENT_CONFIG',
    })
    expect(readCodex()).toBe(broken)
    expect(inspectAgentIntegration(options()).codexDetection).toBe('invalid_config')
  })

  it('refuses to touch Claude settings when all hooks are disabled', () => {
    const original = `${JSON.stringify({ disableAllHooks: true, theme: 'dark' }, null, 2)}\n`
    writeClaude(original)
    expect(setupAgents('install', options())[1]).toEqual({
      agent: 'claude',
      ok: false,
      code: 'CLAUDE_HOOKS_DISABLED',
    })
    expect(readFileSync(claudePath(), 'utf8')).toBe(original)
    expect(inspectAgentIntegration(options()).claudeDetection).toBe('hooks_disabled')
  })

  it('preserves unknown keys and other hooks in Claude settings', () => {
    writeClaude(
      JSON.stringify({
        futureKey: { nested: true },
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo' }] }],
          UserPromptSubmit: [{ matcher: 'src/**', hooks: [{ type: 'command', command: 'lint' }] }],
        },
      }),
    )
    setupAgents('install', options())

    const settings = readClaude()
    expect(settings.futureKey).toEqual({ nested: true })
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>
    expect(hooks.SessionStart).toHaveLength(1)
    expect(hooks.UserPromptSubmit).toHaveLength(2)
    expect(hooks.UserPromptSubmit?.[0]?.matcher).toBe('src/**')
    expect(trackerGroups()).toHaveLength(1)
  })

  it('is idempotent: install twice keeps exactly one entry each', () => {
    setupAgents('install', options())
    const second = setupAgents('install', options())
    expect(second).toEqual([
      { agent: 'codex', ok: true, state: 'unchanged' },
      { agent: 'claude', ok: true, state: 'unchanged' },
    ])
    expect(readCodex().split(CODEX_BLOCK_START)).toHaveLength(2)
    expect(trackerGroups()).toHaveLength(1)
  })

  it('detects a stale path and rewrites only the tracker entry on repair', () => {
    setupAgents('install', options())
    expect(inspectAgentIntegration(options(MOVED_CLI_PATH))).toEqual({
      codexDetection: 'stale',
      claudeDetection: 'stale',
    })

    expect(setupAgents('repair', options(MOVED_CLI_PATH))).toEqual([
      { agent: 'codex', ok: true, state: 'updated' },
      { agent: 'claude', ok: true, state: 'updated' },
    ])
    expect(readCodex()).toContain(MOVED_CLI_PATH)
    expect(readCodex().split(CODEX_BLOCK_START)).toHaveLength(2)
    expect(trackerGroups()).toHaveLength(1)
    expect(inspectAgentIntegration(options(MOVED_CLI_PATH))).toEqual({
      codexDetection: 'ready',
      claudeDetection: 'ready',
    })
  })

  it('uninstall removes only the tracker entries', () => {
    writeCodex('model = "gpt-5.6-terra"\n')
    writeClaude(
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] },
      }),
    )
    setupAgents('install', options())

    expect(setupAgents('uninstall', options())).toEqual([
      { agent: 'codex', ok: true, state: 'removed' },
      { agent: 'claude', ok: true, state: 'removed' },
    ])
    expect(readCodex()).toContain('model = "gpt-5.6-terra"')
    expect(readCodex()).not.toContain(CODEX_BLOCK_START)
    expect(trackerGroups()).toEqual([])
    const hooks = readClaude().hooks as Record<string, unknown[]>
    expect(hooks.UserPromptSubmit).toHaveLength(1)
    expect(inspectAgentIntegration(options())).toEqual({
      codexDetection: 'not_installed',
      claudeDetection: 'not_installed',
    })
  })

  it('uninstall on an untouched home does nothing', () => {
    expect(setupAgents('uninstall', options())).toEqual([
      { agent: 'codex', ok: true, state: 'unchanged' },
      { agent: 'claude', ok: true, state: 'unchanged' },
    ])
  })

  it('reports not_installed on an empty home', () => {
    expect(inspectAgentIntegration(options())).toEqual({
      codexDetection: 'not_installed',
      claudeDetection: 'not_installed',
    })
  })
})

describe('Codex notify chain (DESIGN v2.2 D006)', () => {
  let home: string

  const options = (cliPath = CLI_PATH) => ({ home, nodePath: NODE_PATH, cliPath })
  const codexPath = (): string => join(home, '.codex', 'config.toml')
  const readCodex = (): string => readFileSync(codexPath(), 'utf8')

  function writeCodex(text: string): void {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(codexPath(), text, 'utf8')
  }

  function notifyArgv(): unknown {
    const line = readCodex()
      .split('\n')
      .find((value) => value.startsWith('notify = '))
    return JSON.parse(line?.replace('notify = ', '') ?? '[]')
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adpt-chain-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const EXISTING = ['C:\\\\tools\\\\other-notifier.exe', 'turn-ended']
  const EXISTING_LINE = `notify = ${JSON.stringify(EXISTING)}`

  it('chains an existing notify instead of failing', () => {
    writeCodex(`# user config\n${EXISTING_LINE}\n\n[tui]\ntheme = "dark"\n`)

    const outcomes = setupAgents('install', options())
    expect(outcomes[0]).toEqual({ agent: 'codex', ok: true, state: 'chained' })

    const argv = notifyArgv() as string[]
    expect(argv.slice(0, 7)).toEqual(codexNotifyArgv(NODE_PATH, CLI_PATH))
    expect(argv[7]).toBe('--chain')
    expect(JSON.parse(argv[8] ?? '[]')).toEqual(EXISTING)

    // 既存の他設定は残り、managed block は元の notify 行の位置に入る
    expect(readCodex()).toContain('# user config')
    expect(readCodex()).toContain('theme = "dark"')
    expect(readCodex().split('notify = ')).toHaveLength(2)
    expect(inspectAgentIntegration(options()).codexDetection).toBe('ready')
  })

  it('restores the original config bytes on uninstall', () => {
    const original = `# user config
${EXISTING_LINE}

[tui]
theme = "dark"
`
    writeCodex(original)
    const originalBytes = readFileSync(codexPath())

    setupAgents('install', options())
    expect(setupAgents('uninstall', options())[0]).toEqual({
      agent: 'codex',
      ok: true,
      state: 'removed',
    })
    // 名前どおり全体 byte 一致で検証する (review 指摘4)
    expect(readFileSync(codexPath()).equals(originalBytes)).toBe(true)
    expect(readCodex()).not.toContain(CODEX_BLOCK_START)
  })

  it('keeps the chained argv through install -> install and --repair', () => {
    writeCodex(`${EXISTING_LINE}\n`)
    setupAgents('install', options())

    expect(setupAgents('install', options())[0]).toEqual({
      agent: 'codex',
      ok: true,
      state: 'unchanged',
    })

    expect(setupAgents('repair', options(MOVED_CLI_PATH))[0]).toEqual({
      agent: 'codex',
      ok: true,
      state: 'updated',
    })
    const argv = notifyArgv() as string[]
    expect(argv[1]).toBe(MOVED_CLI_PATH)
    expect(JSON.parse(argv[8] ?? '[]')).toEqual(EXISTING)

    // repair 後も uninstall で元へ戻せる
    setupAgents('uninstall', options(MOVED_CLI_PATH))
    expect(readCodex()).toContain(EXISTING_LINE)
  })

  it('chains a multi-line notify array and restores it verbatim', () => {
    const original = 'notify = [\n  "C:\\\\tools\\\\other.exe",\n  "turn-ended",\n]\n'
    writeCodex(original)

    expect(setupAgents('install', options())[0]).toMatchObject({ ok: true, state: 'chained' })
    expect(JSON.parse((notifyArgv() as string[])[8] ?? '[]')).toEqual([
      'C:\\tools\\other.exe',
      'turn-ended',
    ])

    setupAgents('uninstall', options())
    expect(readCodex()).toBe(original)
  })

  it('still refuses a notify that is not a string array', () => {
    const original = 'notify = 42\n'
    writeCodex(original)
    expect(setupAgents('install', options())[0]).toEqual({
      agent: 'codex',
      ok: false,
      code: 'CODEX_NOTIFY_CONFLICT',
    })
    expect(readCodex()).toBe(original)
    expect(inspectAgentIntegration(options()).codexDetection).toBe('conflict')
  })

  it('reports a config with only a foreign notify as not installed yet', () => {
    writeCodex(`${EXISTING_LINE}\n`)
    expect(inspectAgentIntegration(options()).codexDetection).toBe('not_installed')
  })

  it('leaves the no-chain case unchanged', () => {
    setupAgents('install', options())
    const argv = notifyArgv() as string[]
    expect(argv).toEqual(codexNotifyArgv(NODE_PATH, CLI_PATH))
    expect(readCodex()).not.toContain('previous-notify')

    setupAgents('uninstall', options())
    expect(readCodex()).not.toContain('notify = ')
  })
})

describe('Codex notify chain hardening (review findings 1-4)', () => {
  let home: string

  const options = (cliPath = CLI_PATH) => ({ home, nodePath: NODE_PATH, cliPath })
  const codexPath = (): string => join(home, '.codex', 'config.toml')
  const readCodexBytes = (): Buffer => readFileSync(codexPath())
  const readCodex = (): string => readFileSync(codexPath(), 'utf8')

  function writeCodexBytes(text: string): Buffer {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(codexPath(), text, 'utf8')
    return readFileSync(codexPath())
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adpt-chain-hard-'))
  })

  afterEach(() => {
    setWriteFaultsForTest({})
    rmSync(home, { recursive: true, force: true })
  })

  // --- 指摘1: 退避データの検証 ------------------------------------------

  const corruptions: Array<[string, (encoded: string) => string]> = [
    ['invalid base64', () => '%%%not-base64%%%'],
    ['empty value', () => ''],
    ['valid base64 but not TOML', () => Buffer.from('!!! broken', 'utf8').toString('base64')],
    ['TOML without a notify array', () => Buffer.from('model = "x"', 'utf8').toString('base64')],
    [
      'notify that does not match --chain',
      () => Buffer.from('notify = ["different-notifier"]', 'utf8').toString('base64'),
    ],
  ]

  for (const [label, corrupt] of corruptions) {
    it(`refuses every destructive operation when previous-notify is ${label}`, () => {
      writeCodexBytes('notify = ["C:/tools/other.exe", "turn-ended"]\n\n[tui]\ntheme = "dark"\n')
      setupAgents('install', options())

      const installed = readCodex()
      const encoded = installed
        .split('\n')
        .find((line) => line.startsWith('# previous-notify: '))
        ?.slice('# previous-notify: '.length)
      expect(encoded).toBeDefined()
      const broken = installed.replace(encoded ?? '', corrupt(encoded ?? ''))
      const brokenBytes = writeCodexBytes(broken)

      // doctor は ready にしない
      expect(inspectAgentIntegration(options()).codexDetection).toBe('invalid_config')

      // repair / uninstall / install はいずれも失敗し、file を 1 byte も変えない
      for (const mode of ['install', 'repair', 'uninstall'] as const) {
        expect(setupAgents(mode, options())[0]).toEqual({
          agent: 'codex',
          ok: false,
          code: 'INVALID_AGENT_CONFIG',
        })
        expect(readCodexBytes().equals(brokenBytes)).toBe(true)
      }
    })
  }

  it('refuses when a chained argv has no saved previous-notify', () => {
    writeCodexBytes('notify = ["C:/tools/other.exe", "turn-ended"]\n')
    setupAgents('install', options())
    const stripped = readCodex()
      .split('\n')
      .filter((line) => !line.startsWith('# previous-notify: '))
      .join('\n')
    const strippedBytes = writeCodexBytes(stripped)

    expect(inspectAgentIntegration(options()).codexDetection).toBe('invalid_config')
    expect(setupAgents('uninstall', options())[0]).toMatchObject({ ok: false })
    expect(readCodexBytes().equals(strippedBytes)).toBe(true)
  })

  // --- 指摘2: 文字列 / comment を含む notify の範囲検出 --------------------

  it('keeps later tables intact when the notify argv contains brackets', () => {
    const original = [
      '# user config',
      'notify = ["other[notifier", "turn]ended", "# not a comment"]',
      '',
      '[tui]',
      'theme = "dark"',
      '',
      '[mcp_servers.demo]',
      'command = "demo"',
      '',
    ].join('\n')
    writeCodexBytes(original)

    expect(setupAgents('install', options())[0]).toMatchObject({ ok: true, state: 'chained' })

    const installed = readCodex()
    expect(installed).toContain('[tui]')
    expect(installed).toContain('theme = "dark"')
    expect(installed).toContain('[mcp_servers.demo]')
    expect(installed).toContain('command = "demo"')
    const chained = JSON.parse(
      (
        JSON.parse(
          installed
            .split('\n')
            .find((line) => line.startsWith('notify = '))
            ?.replace('notify = ', '') ?? '[]',
        ) as string[]
      )[8] ?? '[]',
    ) as string[]
    expect(chained).toEqual(['other[notifier', 'turn]ended', '# not a comment'])
  })

  it('handles a multi-line array with comments and restores it byte-for-byte', () => {
    const original = [
      'notify = [ # ここに ] を書いても壊れない',
      '  "C:/tools/other.exe", # 実行体',
      '  "turn-ended",',
      ']',
      '',
      '[tui]',
      'theme = "dark"',
      '',
    ].join('\n')
    const originalBytes = writeCodexBytes(original)

    expect(setupAgents('install', options())[0]).toMatchObject({ ok: true, state: 'chained' })
    expect(readCodex()).toContain('[tui]')

    expect(setupAgents('uninstall', options())[0]).toMatchObject({ ok: true, state: 'removed' })
    expect(readCodexBytes().equals(originalBytes)).toBe(true)
  })

  // --- 指摘3: 書き込みの原子性 -------------------------------------------

  it('leaves the config untouched when the write fails midway', () => {
    const original = 'notify = ["C:/tools/other.exe", "turn-ended"]\n\n[tui]\ntheme = "dark"\n'
    const originalBytes = writeCodexBytes(original)

    setWriteFaultsForTest({
      afterTempWrite: () => {
        throw new Error('disk full')
      },
    })
    expect(() => setupAgents('install', options())).toThrow('disk full')
    expect(readCodexBytes().equals(originalBytes)).toBe(true)
    // temp file を残さない
    expect(readdirSync(join(home, '.codex'))).toEqual(['config.toml'])
  })

  // --- 指摘4: byte-for-byte 復元 -----------------------------------------

  const restoreCases: Array<[string, string]> = [
    ['LF only', 'notify = ["C:/tools/other.exe", "turn-ended"]\n\n[tui]\ntheme = "dark"\n'],
    [
      'CRLF',
      '# user config\r\nnotify = ["C:/tools/other.exe", "turn-ended"]\r\n\r\n[tui]\r\ntheme = "dark"\r\n',
    ],
    [
      'trailing whitespace after the assignment',
      'notify = ["C:/tools/other.exe", "turn-ended"]   \n\n[tui]\ntheme = "dark"\n',
    ],
    [
      'leading blank lines',
      '\n\n\nnotify = ["C:/tools/other.exe", "turn-ended"]\n[tui]\ntheme = "dark"\n',
    ],
    ['no trailing newline', 'notify = ["C:/tools/other.exe", "turn-ended"]'],
    ['inline comment after the assignment', 'notify = ["a", "b"] # keep me\n[tui]\nx = 1\n'],
  ]

  for (const [label, original] of restoreCases) {
    it(`restores the exact original bytes on uninstall (${label})`, () => {
      const originalBytes = writeCodexBytes(original)

      expect(setupAgents('install', options())[0]).toMatchObject({ ok: true, state: 'chained' })
      expect(readCodexBytes().equals(originalBytes)).toBe(false)

      expect(setupAgents('uninstall', options())[0]).toMatchObject({ ok: true, state: 'removed' })
      expect(readCodexBytes().equals(originalBytes)).toBe(true)
    })
  }

  it('restores the exact original bytes when there was no notify at all', () => {
    const original = '# user config\nmodel = "gpt-5.6-terra"\n\n[tui]\ntheme = "dark"\n'
    const originalBytes = writeCodexBytes(original)

    expect(setupAgents('install', options())[0]).toMatchObject({ ok: true, state: 'installed' })
    expect(setupAgents('uninstall', options())[0]).toMatchObject({ ok: true, state: 'removed' })
    expect(readCodexBytes().equals(originalBytes)).toBe(true)
  })

  it('keeps the original bytes across install -> repair -> uninstall', () => {
    const original = '# user\r\nnotify = ["C:/tools/other.exe", "turn-ended"]\r\n[tui]\r\nx = 1\r\n'
    const originalBytes = writeCodexBytes(original)

    setupAgents('install', options())
    setupAgents('repair', options(MOVED_CLI_PATH))
    expect(readCodex()).toContain(MOVED_CLI_PATH)
    setupAgents('uninstall', options(MOVED_CLI_PATH))
    expect(readCodexBytes().equals(originalBytes)).toBe(true)
  })
})

describe('Codex notify chain hardening (re-review findings 1-3)', () => {
  let home: string

  const options = (cliPath = CLI_PATH) => ({ home, nodePath: NODE_PATH, cliPath })
  const codexPath = (): string => join(home, '.codex', 'config.toml')
  const readBytes = (): Buffer => readFileSync(codexPath())
  const readText = (): string => readFileSync(codexPath(), 'utf8')

  function write(text: string): Buffer {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(codexPath(), text, 'utf8')
    return readFileSync(codexPath())
  }

  function expectAllModesUnchanged(bytes: Buffer): void {
    for (const mode of ['install', 'repair', 'uninstall'] as const) {
      expect(setupAgents(mode, options())[0]).toEqual({
        agent: 'codex',
        ok: false,
        code: 'INVALID_AGENT_CONFIG',
      })
      expect(readBytes().equals(bytes)).toBe(true)
    }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adpt-chain-rr-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  // --- 再指摘1: 末尾改行なし / table なし ---------------------------------

  const noTrailingNewline: Array<[string, string]> = [
    ['top-level key only, no trailing newline', 'model = "gpt-5.6-terra"'],
    ['comment only, no trailing newline', '# just a comment'],
    ['empty file', ''],
    ['blank line only', '\n'],
    ['key + table, no trailing newline', 'model = "x"\n[tui]\ntheme = "dark"'],
  ]

  for (const [label, original] of noTrailingNewline) {
    it(`installs and uninstalls byte-for-byte when the config is ${label}`, () => {
      const before = write(original)

      const install = setupAgents('install', options())[0]
      expect(install).toMatchObject({ ok: true, state: 'installed' })

      // install 後は managed として認識され、doctor は ready
      expect(inspectAgentIntegration(options())).toMatchObject({ codexDetection: 'ready' })
      // block は行頭から始まり、直前の値と連結しない
      expect(readText()).toContain(`${CODEX_BLOCK_START}\n`)
      expect(readText()).not.toMatch(/[^\n]# >>> ai-dev-progress-tracker/)

      const uninstall = setupAgents('uninstall', options())[0]
      expect(uninstall).toMatchObject({ ok: true, state: 'removed' })
      expect(readBytes().equals(before)).toBe(true)
    })
  }

  it('keeps the config parseable and top-level after installing into a file with tables', () => {
    write('model = "x"\n[tui]\ntheme = "dark"')
    setupAgents('install', options())
    const parsed = parseToml(readText()) as Record<string, unknown>
    expect(Array.isArray(parsed.notify)).toBe(true)
    expect(parsed.model).toBe('x')
    expect(parsed.tui).toEqual({ theme: 'dark' })
  })

  // --- 再指摘2: marker 文字列の偶然一致 -----------------------------------

  it('refuses to touch a config whose own comments contain the markers', () => {
    const original = [
      CODEX_BLOCK_START,
      '# 利用者が書いたメモ。tracker の block ではない。',
      'model = "gpt-5.6-terra"',
      CODEX_BLOCK_END,
      'notify = ["C:/tools/other.exe", "turn-ended"]',
      '',
      '[tui]',
      'theme = "dark"',
      '',
    ].join('\n')
    const before = write(original)

    expect(inspectAgentIntegration(options()).codexDetection).toBe('invalid_config')
    expectAllModesUnchanged(before)
  })

  it('refuses when a stray start marker exists outside a valid block', () => {
    const original = [
      `${CODEX_BLOCK_START} (メモ)`,
      'notify = ["C:/tools/other.exe", "turn-ended"]',
      '',
    ].join('\n')
    const before = write(original)

    expect(inspectAgentIntegration(options()).codexDetection).toBe('invalid_config')
    expectAllModesUnchanged(before)
  })

  it('refuses when the managed block carries extra user lines', () => {
    write('notify = ["C:/tools/other.exe", "turn-ended"]\n')
    setupAgents('install', options())
    const tampered = readText().replace(
      `${CODEX_BLOCK_END}`,
      `model = "sneaked-in"\n${CODEX_BLOCK_END}`,
    )
    const before = write(tampered)

    expect(inspectAgentIntegration(options()).codexDetection).toBe('invalid_config')
    expectAllModesUnchanged(before)
  })

  // --- 再指摘3: --chain なし vs 不正 --------------------------------------

  it('treats an invalid --chain payload as corrupt in every mode', () => {
    write('notify = ["C:/tools/other.exe", "turn-ended"]\n')
    setupAgents('install', options())
    // 退避行を消し、--chain を壊れた JSON にする
    const tampered = readText()
      .split('\n')
      .filter((line) => !line.startsWith('# previous-notify: '))
      .join('\n')
      .replace(/"--chain", "[^"]*"/, '"--chain", "{not json"')
    const before = write(tampered)

    expect(inspectAgentIntegration(options()).codexDetection).toBe('invalid_config')
    expectAllModesUnchanged(before)
  })

  it('treats a --chain flag with no value as corrupt', () => {
    write('notify = ["C:/tools/other.exe", "turn-ended"]\n')
    setupAgents('install', options())
    // argv の末尾を `--chain` だけにする (値なし)
    const tampered = readText()
      .split('\n')
      .map((line) => {
        if (!line.startsWith('notify = ')) {
          return line
        }
        const argv = JSON.parse(line.replace('notify = ', '')) as string[]
        return `notify = ${JSON.stringify([...argv.slice(0, argv.indexOf('--chain')), '--chain'])}`
      })
      .join('\n')
    const before = write(tampered)

    expect(inspectAgentIntegration(options()).codexDetection).toBe('invalid_config')
    expectAllModesUnchanged(before)
  })

  it('still treats a block with no --chain and no previous-notify as managed', () => {
    write('model = "x"\n')
    setupAgents('install', options())
    expect(readText()).not.toContain('--chain')
    expect(readText()).not.toContain('previous-notify')
    expect(inspectAgentIntegration(options()).codexDetection).toBe('ready')
    expect(setupAgents('install', options())[0]).toMatchObject({ ok: true, state: 'unchanged' })
  })
})
