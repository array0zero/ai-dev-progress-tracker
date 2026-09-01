import { spawn } from 'node:child_process'

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

/**
 * child processを shell:false で起動する。
 * timeout到達時はchild processをkillし、`timedOut: true` で解決する。
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stdout = new BoundedCapture()
    const stderr = new BoundedCapture()
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
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
      rejectPromise(error)
    })

    child.on('close', (code, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolvePromise({
        code,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      })
    })

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    } else {
      child.stdin?.end()
    }
  })
}
