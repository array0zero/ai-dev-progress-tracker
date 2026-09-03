import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/server/db/connection.js'
import { listProjects } from '../../src/server/db/project-repository.js'

// server の起動と親プロセスの消滅を実プロセスで確認するため、既定の 5 秒では足りない。
vi.setConfig({ testTimeout: 60_000 })

const PORT = 4321
const SHUTDOWN_TIMEOUT_MS = 15_000

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve_) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve_(true)
      return
    }
    const timer = setTimeout(() => resolve_(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve_(true)
    })
  })
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) {
        return true
      }
    } catch {
      // not ready yet
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  return false
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => done(true))
    })
  })
}

describe('server shutdown', () => {
  let dataDir: string
  let parent: ChildProcess | null = null
  let server: ChildProcess | null = null

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adpt-shutdown-'))
  })

  afterEach(async () => {
    for (const child of [server, parent]) {
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await waitForExit(child, 5_000)
      }
    }
    server = null
    parent = null
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('exits through the watchdog when the parent dies without sending a signal', async () => {
    // watchdog の対象にする「親」。signal は一切送らず SIGKILL で消す。
    parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    expect(parent.pid).toBeGreaterThan(0)

    server = spawn(process.execPath, ['--import', 'tsx', resolve('src/server/index.ts')], {
      env: {
        ...process.env,
        TRACKER_DATA_DIR: dataDir,
        TRACKER_PORT: String(PORT),
        TRACKER_PARENT_PID: String(parent.pid),
      },
      stdio: 'ignore',
      // process group の連鎖ではなく watchdog 自身で終わることを見る。
      detached: false,
    })

    expect(await waitForHealth(PORT, 30_000)).toBe(true)
    expect(await portIsFree(PORT)).toBe(false)

    parent.kill('SIGKILL')
    expect(await waitForExit(server, SHUTDOWN_TIMEOUT_MS)).toBe(true)

    // port が解放されている
    expect(await portIsFree(PORT)).toBe(true)

    // DB handle が閉じている: 別プロセスから開いて読め、data dir ごと削除もできる
    const db = openDatabase(join(dataDir, 'tracker.db'))
    try {
      expect(listProjects(db)).toEqual([])
    } finally {
      db.close()
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    dataDir = mkdtempSync(join(tmpdir(), 'adpt-shutdown-'))
  })

  it('exits on SIGTERM as well', async () => {
    server = spawn(process.execPath, ['--import', 'tsx', resolve('src/server/index.ts')], {
      env: { ...process.env, TRACKER_DATA_DIR: dataDir, TRACKER_PORT: String(PORT + 1) },
      stdio: 'ignore',
    })
    expect(await waitForHealth(PORT + 1, 30_000)).toBe(true)

    server.kill('SIGTERM')
    expect(await waitForExit(server, SHUTDOWN_TIMEOUT_MS)).toBe(true)
    expect(await portIsFree(PORT + 1)).toBe(true)
  })

  it('does not watch anything without TRACKER_PARENT_PID', async () => {
    parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    server = spawn(process.execPath, ['--import', 'tsx', resolve('src/server/index.ts')], {
      env: { ...process.env, TRACKER_DATA_DIR: dataDir, TRACKER_PORT: String(PORT + 2) },
      stdio: 'ignore',
    })
    expect(await waitForHealth(PORT + 2, 30_000)).toBe(true)

    parent.kill('SIGKILL')
    // 監視していないので生き続ける
    expect(await waitForExit(server, 3_000)).toBe(false)
    expect(await portIsFree(PORT + 2)).toBe(false)
  })
})
