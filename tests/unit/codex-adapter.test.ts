import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCodexReady, runCodexGeneration } from '../../src/server/adapters/codex.js'
import { createFakeCodex, type FakeCodex } from '../helpers/fake-codex.js'

const VALID_OUTPUT = {
  schemaVersion: 1,
  currentPosition: { status: 'needs_input', text: '要補完', evidenceIds: [] },
  completedItems: { status: 'needs_input', items: [], evidenceIds: [] },
  nextActions: { status: 'needs_input', items: [], evidenceIds: [] },
  importantDecisions: { status: 'needs_input', items: [], evidenceIds: [] },
}

describe('codex adapter', () => {
  const fakes: FakeCodex[] = []

  function fakeCodex(config: Parameters<typeof createFakeCodex>[0]): FakeCodex {
    const fake = createFakeCodex(config)
    fakes.push(fake)
    for (const [key, value] of Object.entries(fake.env)) {
      vi.stubEnv(key, value)
    }
    return fake
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    while (fakes.length > 0) {
      fakes.pop()?.cleanup()
    }
  })

  it('rejects Codex 0.151.9 before exec with CODEX_VERSION_UNSUPPORTED (version obtained, below minimum)', async () => {
    fakeCodex({ version: 'codex-cli 0.151.9', authMode: 'chatgpt' })
    const result = await checkCodexReady()
    expect(result).toEqual({ ok: false, code: 'CODEX_VERSION_UNSUPPORTED' })
  })

  it('reports CODEX_VERSION_CHECK_FAILED when `codex` cannot be executed at all', async () => {
    // 実体のないパスを bin に指定 → spawn error
    vi.stubEnv('TRACKER_CODEX_BIN', '/no/such/codex-binary-xyz')
    vi.stubEnv('TRACKER_CODEX_ARGS', '')
    expect(await checkCodexReady()).toEqual({ ok: false, code: 'CODEX_VERSION_CHECK_FAILED' })
  })

  it('reports CODEX_VERSION_CHECK_FAILED when `codex --version` exits non-zero', async () => {
    fakeCodex({ version: 'codex-cli 0.152.0', versionExitCode: 3, authMode: 'chatgpt' })
    expect(await checkCodexReady()).toEqual({ ok: false, code: 'CODEX_VERSION_CHECK_FAILED' })
  })

  it('reports VERSION_PARSE_ERROR when the version output has no MAJOR.MINOR.PATCH', async () => {
    fakeCodex({ version: 'codex latest (nightly build)', authMode: 'chatgpt' })
    expect(await checkCodexReady()).toEqual({ ok: false, code: 'VERSION_PARSE_ERROR' })
  })

  it('passes the version check for 0.152.0 and 0.153.0 with ChatGPT auth', async () => {
    for (const version of ['codex-cli 0.152.0', 'codex-cli 0.153.0']) {
      vi.unstubAllEnvs()
      fakeCodex({ version, authMode: 'chatgpt' })
      const result = await checkCodexReady()
      expect(result.ok).toBe(true)
    }
  })

  it('rejects API key auth with AI_AUTH_NOT_CHATGPT', async () => {
    fakeCodex({ version: 'codex-cli 0.152.0', authMode: 'apikey' })
    expect(await checkCodexReady()).toEqual({ ok: false, code: 'AI_AUTH_NOT_CHATGPT' })
  })

  it('reports CODEX_AUTH_REQUIRED when not logged in', async () => {
    fakeCodex({ version: 'codex-cli 0.152.0', authMode: 'none' })
    expect(await checkCodexReady()).toEqual({ ok: false, code: 'CODEX_AUTH_REQUIRED' })
  })

  it('runs exec with the fixed argv and returns the parsed output', async () => {
    const fake = fakeCodex({ output: VALID_OUTPUT })
    const result = await runCodexGeneration('the prompt body')
    expect(result).toEqual({ ok: true, output: VALID_OUTPUT })

    const execCall = fake.calls().find((call) => call.includes('exec'))
    expect(execCall).toBeDefined()
    expect(execCall).toEqual(
      expect.arrayContaining([
        '--model',
        'gpt-5.6-terra',
        '--ask-for-approval',
        'never',
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--skip-git-repo-check',
        '--output-schema',
        '--output-last-message',
        '-',
      ]),
    )
    expect(fake.prompt()).toBe('the prompt body')
  })

  it('treats a non-zero exec exit code as CODEX_EXEC_FAILED', async () => {
    fakeCodex({ execExitCode: 1 })
    expect(await runCodexGeneration('p')).toEqual({ ok: false, code: 'CODEX_EXEC_FAILED' })
  })

  it('treats invalid JSON output as CODEX_OUTPUT_INVALID', async () => {
    fakeCodex({ outputRaw: '{ not json' })
    expect(await runCodexGeneration('p')).toEqual({ ok: false, code: 'CODEX_OUTPUT_INVALID' })
  })

  it('scrubs OpenAI / Anthropic / GitHub credentials from the child env', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-should-not-leak')
    vi.stubEnv('OPENAI_ORG_ID', 'org-should-not-leak')
    vi.stubEnv('OPENAI_PROJECT_ID', 'proj-should-not-leak')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-should-not-leak')
    vi.stubEnv('GH_TOKEN', 'ghp_should_not_leak')
    vi.stubEnv('GITHUB_TOKEN', 'ghp_should_not_leak_either')
    const fake = fakeCodex({ output: VALID_OUTPUT })

    await runCodexGeneration('p')

    expect(fake.envDump()).toEqual({
      OPENAI_API_KEY: null,
      OPENAI_ORG_ID: null,
      OPENAI_PROJECT_ID: null,
      ANTHROPIC_API_KEY: null,
      GH_TOKEN: null,
      GITHUB_TOKEN: null,
    })
  })
})
