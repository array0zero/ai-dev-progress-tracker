import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, extname, isAbsolute } from 'node:path'

/** stdout / stderr はそれぞれ最大 1 MiB までしかcaptureしない。 */
export const MAX_CAPTURE_BYTES = 1024 * 1024

export interface RunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly input?: string
}

export interface RunResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

class BoundedCapture {
  private readonly chunks: Buffer[] = []
  private length = 0
  truncated = false

  add(chunk: Buffer): void {
    if (this.length >= MAX_CAPTURE_BYTES) {
      this.truncated = true
      return
    }
    const remaining = MAX_CAPTURE_BYTES - this.length
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining))
      this.length = MAX_CAPTURE_BYTES
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.length += chunk.length
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

// --- Windows で .cmd / .bat shim を shell 無しで起動するための解決 ---------
//
// Node は shell:false のとき .cmd / .bat を直接 spawn できない (CVE-2024-27980)。
// PATH + PATHEXT から実体を解決し、shim なら %ComSpec% /d /s /c 経由で起動する。
// cmd.exe への引数エスケープは cross-spawn 相当。

const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function escapeForCmd(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  escaped = `"${escaped}"`
  return escaped.replace(CMD_META, '^$1')
}

function escapeCommandForCmd(command: string): string {
  return command.replace(CMD_META, '^$1')
}

function resolveWindowsExecutable(command: string): string | null {
  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    return existsSync(command) ? command : null
  }
  if (extname(command) !== '') {
    return command
  }
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext !== '')
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = `${dir}\\${command}${ext}`
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return null
}

interface SpawnSpec {
  file: string
  args: string[]
  windowsVerbatimArguments: boolean
}

export function buildSpawnSpec(command: string, args: readonly string[]): SpawnSpec {
  if (process.platform !== 'win32') {
    return { file: command, args: [...args], windowsVerbatimArguments: false }
  }
  const resolved = resolveWindowsExecutable(command)
  if (resolved === null) {
    // 見つからなければ従来どおり spawn に委ねて error イベントで失敗させる。
    return { file: command, args: [...args], windowsVerbatimArguments: false }
  }
  const ext = extname(resolved).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    const line = [escapeCommandForCmd(resolved), ...args.map(escapeForCmd)].join(' ')
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    }
  }
  return { file: resolved, args: [...args], windowsVerbatimArguments: false }
}

/**
 * child processを shell:false で起動する。
 * Windows の .cmd / .bat shim は %ComSpec% /d /s /c 経由で起動する (それでも shell:false)。
 * timeout到達時はchild processをkillし、`timedOut: true` で解決する。
 */
/**
 * timeout 到達時の停止手順。
 * Windows では `.cmd` shim を経由して起動するため、child (cmd.exe) を kill しても
 * その先の実体 (codex / node) は生き続け、継承した stdout/stderr pipe も開いたままになる。
 * すると `close` が発火せず、`runProcess` が timeout 後も解決しない
 * (運用で CODEX_TIMEOUT が 120 秒ではなく 14 分後に確定した原因)。
 * そのため (1) process tree ごと停止し、(2) それでも close が来ない場合は
 * grace 経過後に timedOut として強制的に解決する。
 */
export const KILL_GRACE_MS = 2_000

function killProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (pid !== undefined && process.platform === 'win32') {
    // taskkill /t は親子関係を辿るので、先に shim を kill すると実体が orphan になり
    // 取りこぼす。tree が壊れていないうちに子孫ごと落とす。
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        timeout: KILL_GRACE_MS,
      })
      return
    } catch {
      // 既に終了している / taskkill 不可。下の kill へ落とす。
    }
  }
  try {
    child.kill()
  } catch {
    // 既に終了している
  }
  if (pid === undefined || process.platform === 'win32') {
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // 既に終了している
  }
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise, rejectPromise) => {
    const spec = buildSpawnSpec(command, args)
    const child = spawn(spec.file, spec.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stdout = new BoundedCapture()
    const stderr = new BoundedCapture()
    let timedOut = false
    let settled = false

    const settle = (result: RunResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      resolvePromise(result)
    }

    const snapshot = (code: number | null, signal: NodeJS.Signals | null): RunResult => ({
      code,
      signal,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      timedOut,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    })

    let forceTimer: NodeJS.Timeout = setTimeout(() => undefined, 0)
    clearTimeout(forceTimer)

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
      // kill しても pipe が閉じない (孫プロセスが握っている) 場合に備え、
      // grace 経過後は timedOut として強制的に解決する。
      forceTimer = setTimeout(() => settle(snapshot(null, null)), KILL_GRACE_MS)
      forceTimer.unref()
    }, options.timeoutMs)
    timer.unref()

    child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk))

    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      rejectPromise(error)
    })

    child.on('close', (code, signal) => {
      settle(snapshot(code, signal))
    })

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    } else {
      child.stdin?.end()
    }
  })
}
