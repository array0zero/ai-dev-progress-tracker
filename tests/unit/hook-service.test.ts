import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertHooksInstallable,
  beginMarker,
  installHooks,
} from '../../src/server/services/hook-service.js'

const CLI_PATH = '/opt/tracker/dist/cli/index.js'

describe('hook-service', () => {
  let gitDir: string
  let hooksDir: string

  beforeEach(() => {
    gitDir = mkdtempSync(join(tmpdir(), 'adpt-hooks-'))
    hooksDir = join(gitDir, 'hooks')
  })

  afterEach(() => {
    rmSync(gitDir, { recursive: true, force: true })
  })

  it('creates both hooks with a shebang and a managed block when none exist', async () => {
    const result = await installHooks(gitDir, 'proj-1', CLI_PATH)
    expect(result.ok).toBe(true)
    expect(result.installed).toHaveLength(2)

    const postCommit = readFileSync(join(hooksDir, 'post-commit'), 'utf8')
    const prePush = readFileSync(join(hooksDir, 'pre-push'), 'utf8')

    expect(postCommit.startsWith('#!/bin/sh\n')).toBe(true)
    expect(postCommit).toContain(beginMarker('proj-1'))
    expect(postCommit).toContain('hook-commit')
    expect(postCommit).toContain(CLI_PATH)

    expect(prePush.startsWith('#!/bin/sh\n')).toBe(true)
    expect(prePush).toContain('hook-backup')
    expect(prePush).toContain('|| true')
  })

  it('preserves an existing shebang hook byte-for-byte and appends the block', async () => {
    mkdirSync(hooksDir, { recursive: true })
    const original = '#!/bin/sh\necho "existing behaviour"\n'
    writeFileSync(join(hooksDir, 'post-commit'), original)

    const result = await installHooks(gitDir, 'proj-1', CLI_PATH)

    expect(result.ok).toBe(true)
    const updated = readFileSync(join(hooksDir, 'post-commit'), 'utf8')
    expect(updated.startsWith(original)).toBe(true)
    expect(updated).toContain(beginMarker('proj-1'))
  })

  it('fails with HOOK_UNSUPPORTED and changes nothing when an existing hook has no shebang', async () => {
    mkdirSync(hooksDir, { recursive: true })
    const postOriginal = '#!/bin/sh\necho ok\n'
    const preOriginal = 'echo no shebang here\n'
    writeFileSync(join(hooksDir, 'post-commit'), postOriginal)
    writeFileSync(join(hooksDir, 'pre-push'), preOriginal)

    const result = await installHooks(gitDir, 'proj-1', CLI_PATH)

    expect(result).toEqual({ ok: false, code: 'HOOK_UNSUPPORTED', installed: [] })
    expect(readFileSync(join(hooksDir, 'post-commit'), 'utf8')).toBe(postOriginal)
    expect(readFileSync(join(hooksDir, 'pre-push'), 'utf8')).toBe(preOriginal)
  })

  it('does not add a second managed block for the same project id', async () => {
    await installHooks(gitDir, 'proj-1', CLI_PATH)
    await installHooks(gitDir, 'proj-1', CLI_PATH)

    const postCommit = readFileSync(join(hooksDir, 'post-commit'), 'utf8')
    expect(postCommit.split(beginMarker('proj-1')).length - 1).toBe(1)
  })

  it('adds a distinct managed block for a different project id', async () => {
    await installHooks(gitDir, 'proj-1', CLI_PATH)
    await installHooks(gitDir, 'proj-2', CLI_PATH)

    const postCommit = readFileSync(join(hooksDir, 'post-commit'), 'utf8')
    expect(postCommit).toContain(beginMarker('proj-1'))
    expect(postCommit).toContain(beginMarker('proj-2'))
  })

  it('assertHooksInstallable reports HOOK_UNSUPPORTED for a non-shebang hook', async () => {
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(join(hooksDir, 'pre-push'), 'plain script\n')
    expect(await assertHooksInstallable(gitDir)).toEqual({ ok: false, code: 'HOOK_UNSUPPORTED' })
  })
})
