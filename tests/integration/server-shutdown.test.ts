import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/server/db/connection.js'
import { listProjects } from '../../src/server/db/project-repository.js'

// server の起動と親プロセスの消滅を実プロセスで確認するため、既定の 5 秒では足りない。
vi.setConfig({ testTimeout: 60_000 })

const PORT = 4321
const SHUTDOWN_TIMEOUT_MS = 15_000

/** src (tsx) と build 済み dist の両方を同じ条件で確認する。 */
const SOURCE_ENTRY = ['--import', 'tsx', resolve('src/server/index.ts')]
const DIST_ENTRY = [resolve('dist/server/index.js')]

/**
 * dist entry は **毎回 build し直してから**検証する。
 * `test:all` は test → build の順なので、古い dist が残っていると
 * 現在の source ではない artifact を検証してしまう (review 指摘2)。
 */
function buildDistEntry(): void {
  execFileSync('npm', ['run', 'build:server'], { stdio: 'ignore', shell: true, timeout: 300_000 })
  if (!existsSync(resolve('dist/server/index.js'))) {
    throw new Error('build:server did not produce dist/server/index.js')
  }
}

/** build 済み entry が現在の source より新しいこと (鮮度) を確かめる。 */
function distIsFresherThanSource(): boolean {
  const dist = statSync(resolve('dist/server/index.js')).mtimeMs
  return statSync(resolve('src/server/index.ts')).mtimeMs <= dist
}

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

  beforeAll(() => {
    // dist entry を検証する前に必ず build し直す。
    buildDistEntry()
  }, 300_000)

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adpt-shutdown-'))
  })

  it('verifies the built entry against the current source', () => {
    expect(existsSync(resolve('dist/server/index.js'))).toBe(true)
    expect(distIsFresherThanSource()).toBe(true)
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

  function startServer(entry: readonly string[], port: number, parentPid?: number): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRACKER_DATA_DIR: dataDir,
      TRACKER_PORT: String(port),
    }
    if (parentPid !== undefined) {
      env.TRACKER_PARENT_PID = String(parentPid)
    }
    // process group の連鎖ではなく watchdog / signal 自身で終わることを見る。
    return spawn(process.execPath, [...entry], { env, stdio: 'ignore', detached: false })
  }

  // 実運用 (npm start) と E2E は dist を起動するので、両方の entry で同じ経路を確認する。
  const entries: Array<[string, () => readonly string[], number]> = [
    ['source entry (tsx)', () => SOURCE_ENTRY, PORT],
    ['built entry (dist)', () => DIST_ENTRY, PORT + 10],
  ]

  for (const [label, entry, basePort] of entries) {
    it(`exits through the watchdog when the parent dies without a signal: ${label}`, async () => {
      // watchdog の対象にする「親」。signal は一切送らず SIGKILL で消す。
      parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      expect(parent.pid).toBeGreaterThan(0)

      server = startServer(entry(), basePort, parent.pid)
      expect(await waitForHealth(basePort, 60_000)).toBe(true)
      expect(await portIsFree(basePort)).toBe(false)

      parent.kill('SIGKILL')
      expect(await waitForExit(server, SHUTDOWN_TIMEOUT_MS)).toBe(true)

      // port が解放されている
      expect(await portIsFree(basePort)).toBe(true)

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

    it(`exits on SIGTERM: ${label}`, async () => {
      server = startServer(entry(), basePort + 1)
      expect(await waitForHealth(basePort + 1, 60_000)).toBe(true)

      server.kill('SIGTERM')
      expect(await waitForExit(server, SHUTDOWN_TIMEOUT_MS)).toBe(true)
      expect(await portIsFree(basePort + 1)).toBe(true)
    })
  }

  it('does not watch anything without TRACKER_PARENT_PID', async () => {
    parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    server = startServer(SOURCE_ENTRY, PORT + 2)
    expect(await waitForHealth(PORT + 2, 60_000)).toBe(true)

    parent.kill('SIGKILL')
    // 監視していないので生き続ける
    expect(await waitForExit(server, 3_000)).toBe(false)
    expect(await portIsFree(PORT + 2)).toBe(false)
  })
})
