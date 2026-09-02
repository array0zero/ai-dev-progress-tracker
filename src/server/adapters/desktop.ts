import { spawn } from 'node:child_process'
import { runProcess } from './process-runner.js'

const BROWSER_OPEN_TIMEOUT_MS = 3_000

/** 既定ブラウザで URL を開く。shell を経由しない。 */
export async function openUrl(url: string, timeoutMs = BROWSER_OPEN_TIMEOUT_MS): Promise<boolean> {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const result = await runProcess(command, args as string[], { timeoutMs })
    return result.code === 0 && !result.timedOut
  } catch {
    return false
  }
}

/**
 * agent hook を止めないよう、server は detached + stdio ignore で起動して即 unref する。
 * hook 側の process が終了しても server は生き残る。
 */
export function spawnDetachedServer(serverEntry: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const child = spawn(process.execPath, [serverEntry], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

export async function isServerHealthy(port: number, timeoutMs = 500): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}
