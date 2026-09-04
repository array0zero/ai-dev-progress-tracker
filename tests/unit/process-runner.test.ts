import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KILL_GRACE_MS, runProcess } from '../../src/server/adapters/process-runner.js'

vi.setConfig({ testTimeout: 30_000 })

/**
 * 実運用で CODEX_TIMEOUT が timeout 値 (120 秒) ではなく 855 秒後に確定した。
 * `.cmd` shim 経由で起動すると shim (cmd.exe) を kill しても実体が生き残り、
 * 継承した stdout/stderr pipe が閉じないため `close` が来ないのが原因。
 * ここでは shim を再現し、timeout が有限時間で必ず確定することを見る。
 */
function writeHangingShim(dir: string): string {
  if (process.platform === 'win32') {
    const shim = join(dir, 'hang.cmd')
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" -e "setInterval(()=>{},1000)"\r\n`)
    return shim
  }
  const shim = join(dir, 'hang.sh')
  writeFileSync(shim, `#!/bin/sh\n"${process.execPath}" -e 'setInterval(()=>{},1000)' &\nwait\n`)
  chmodSync(shim, 0o755)
  return shim
}

describe('runProcess timeout', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adpt-runner-'))
  })

  afterEach(() => {
    // kill 直後は実体がまだ cwd を掴んでいることがあるので retry する。
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      // temp なので OS の後始末に任せる
    }
  })

  it('settles as timedOut even when the real process outlives the shim', async () => {
    const shim = writeHangingShim(dir)
    const started = Date.now()

    const result = await runProcess(shim, [], { cwd: dir, timeoutMs: 2_000 })
    const elapsed = Date.now() - started

    expect(result.timedOut).toBe(true)
    // timeout + kill grace + 起動/後始末の余裕。修正前はここで永久に解決しなかった。
    expect(elapsed).toBeLessThan(2_000 + KILL_GRACE_MS + 10_000)
  })

  it('does not report a timeout for a process that exits in time', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      cwd: dir,
      timeoutMs: 20_000,
    })

    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ok')
  })
})
