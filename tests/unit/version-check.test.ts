import { describe, expect, it } from 'vitest'
import { runProcess } from '../../src/server/adapters/process-runner.js'
import { checkVersion, extractVersion, VERSION_REQUIREMENTS } from '../../src/server/config.js'

describe('checkVersion', () => {
  const passCases: Array<[keyof typeof VERSION_REQUIREMENTS, string]> = [
    ['node', 'v24.15.0'],
    ['node', 'v24.99.99'],
    ['git', 'git version 2.45.0'],
    ['git', 'git version 3.0.0'],
    ['gh', 'gh version 2.98.0 (2026-01-01)'],
    ['gh', 'gh version 3.0.0 (2026-01-01)'],
    ['codex', 'codex-cli 0.146.0'],
    ['codex', 'codex-cli 0.147.0'],
  ]

  const failCases: Array<[keyof typeof VERSION_REQUIREMENTS, string, string]> = [
    ['node', 'v24.14.9', 'NODE_VERSION_UNSUPPORTED'],
    ['node', 'v25.0.0', 'NODE_VERSION_UNSUPPORTED'],
    ['git', 'git version 2.44.9', 'GIT_VERSION_UNSUPPORTED'],
    ['gh', 'gh version 2.97.9 (2026-01-01)', 'GH_VERSION_UNSUPPORTED'],
    ['codex', 'codex-cli 0.145.9', 'CODEX_VERSION_UNSUPPORTED'],
  ]

  for (const [key, raw] of passCases) {
    it(`accepts ${key} "${raw}"`, () => {
      expect(checkVersion(raw, VERSION_REQUIREMENTS[key]).ok).toBe(true)
    })
  }

  for (const [key, raw, code] of failCases) {
    it(`rejects ${key} "${raw}" with ${code}`, () => {
      const result = checkVersion(raw, VERSION_REQUIREMENTS[key])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe(code)
      }
    })
  }

  it('returns VERSION_PARSE_ERROR when no MAJOR.MINOR.PATCH is present', () => {
    expect(checkVersion('no version here', VERSION_REQUIREMENTS.node)).toEqual({
      ok: false,
      code: 'VERSION_PARSE_ERROR',
    })
    expect(checkVersion('git version 2.45', VERSION_REQUIREMENTS.git)).toEqual({
      ok: false,
      code: 'VERSION_PARSE_ERROR',
    })
  })

  it('extracts the first triple and ignores prerelease/build metadata', () => {
    expect(extractVersion('v24.15.0-nightly.20260101+abcdef')).toEqual([24, 15, 0])
    expect(extractVersion('codex 0.146.0-rc.1')).toEqual([0, 146, 0])
    expect(extractVersion('2.45')).toBeNull()
  })
})

describe('runProcess', () => {
  it('captures stdout from a short-lived process', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("hello")'], {
      timeoutMs: 5_000,
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(result.timedOut).toBe(false)
  })

  it('kills a process that exceeds the timeout', async () => {
    const startedAt = Date.now()
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 300,
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('truncates captured output at 1 MiB', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(3 * 1024 * 1024))'],
      { timeoutMs: 5_000 },
    )
    expect(result.stdout.length).toBe(1024 * 1024)
    expect(result.stdoutTruncated).toBe(true)
  })

  it('feeds stdin input without a shell', async () => {
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        'let d="";process.stdin.on("data",c=>{d+=c}).on("end",()=>process.stdout.write(d.toUpperCase()))',
      ],
      { timeoutMs: 5_000, input: 'abc' },
    )
    expect(result.stdout).toBe('ABC')
  })
})
