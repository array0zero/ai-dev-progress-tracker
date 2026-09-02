import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  claudeHookArgs,
  codexNotifyArgv,
  inspectAgentIntegration,
  resolveIntegration,
  setupAgents,
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

  it('leaves the Codex config byte-identical when another notify exists', () => {
    const original = '# user config\nnotify = ["my-notifier", "--flag"]\n\n[tui]\ntheme = "dark"\n'
    writeCodex(original)
    const outcomes = setupAgents('install', options())
    expect(outcomes[0]).toEqual({ agent: 'codex', ok: false, code: 'CODEX_NOTIFY_CONFLICT' })
    expect(readCodex()).toBe(original)
    expect(inspectAgentIntegration(options()).codexDetection).toBe('conflict')
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
