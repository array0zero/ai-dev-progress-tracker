import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK_NAMES = ['post-commit', 'pre-push'] as const
type HookName = (typeof HOOK_NAMES)[number]

export type HookInstallErrorCode = 'HOOK_UNSUPPORTED'

export interface HookInstallResult {
  ok: boolean
  code?: HookInstallErrorCode
  installed: string[]
}

export function beginMarker(projectId: string): string {
  return `# AI_DEV_PROGRESS_TRACKER_BEGIN:${projectId}`
}

export function endMarker(projectId: string): string {
  return `# AI_DEV_PROGRESS_TRACKER_END:${projectId}`
}

export function defaultTrackerCliPath(): string {
  // dist/server/services/hook-service.js -> dist/cli/index.js
  return fileURLToPath(new URL('../../../dist/cli/index.js', import.meta.url))
}

function managedBlock(hook: HookName, projectId: string, trackerCliPath: string): string {
  const command = hook === 'post-commit' ? 'hook-commit' : 'hook-backup'
  const tail = hook === 'pre-push' ? ' || true' : ''
  return `${beginMarker(projectId)}
node "${trackerCliPath}" ${command} \\
  --project-id "${projectId}" \\
  --repo "$(git rev-parse --show-toplevel)" \\
  --sha "$(git rev-parse HEAD)" >/dev/null 2>&1${tail}
${endMarker(projectId)}
`
}

type HookState = 'absent' | 'append' | 'already' | 'unsupported'

async function classifyHook(hookPath: string, projectId: string): Promise<HookState> {
  let content: string
  try {
    content = await readFile(hookPath, 'utf8')
  } catch {
    return 'absent'
  }
  if (content.includes(beginMarker(projectId))) {
    return 'already'
  }
  // 既存hookがshebangで始まらない場合は一切触らない。
  if (!content.startsWith('#!')) {
    return 'unsupported'
  }
  return 'append'
}

/** 書き込みを行わずに2種hookが設置可能か (既存の非shebang hookがないか) だけを判定する。 */
export async function assertHooksInstallable(
  gitDir: string,
): Promise<{ ok: true } | { ok: false; code: HookInstallErrorCode }> {
  for (const name of HOOK_NAMES) {
    const hookPath = join(gitDir, 'hooks', name)
    try {
      const content = await readFile(hookPath, 'utf8')
      if (!content.startsWith('#!')) {
        return { ok: false, code: 'HOOK_UNSUPPORTED' }
      }
    } catch {
      // hookが存在しない = 設置可能
    }
  }
  return { ok: true }
}

/**
 * post-commit / pre-push へ marker 付き管理ブロックを追加する。
 * - 新規hookは先頭に `#!/bin/sh` を入れる。
 * - 既存shebang付きhookは本文をbyte単位で保持したまま追記する。
 * - shebangなし既存hookは変更せず HOOK_UNSUPPORTED。
 * - 同じproject IDの管理ブロックは重複追加しない。
 */
export async function installHooks(
  gitDir: string,
  projectId: string,
  trackerCliPath: string = defaultTrackerCliPath(),
): Promise<HookInstallResult> {
  const hooksDir = join(gitDir, 'hooks')
  const preflight = await assertHooksInstallable(gitDir)
  if (!preflight.ok) {
    return { ok: false, code: preflight.code, installed: [] }
  }

  await mkdir(hooksDir, { recursive: true })
  const installed: string[] = []

  for (const name of HOOK_NAMES) {
    const hookPath = join(hooksDir, name)
    const state = await classifyHook(hookPath, projectId)
    if (state === 'already') {
      continue
    }
    const block = managedBlock(name, projectId, trackerCliPath)
    if (state === 'absent') {
      await writeFile(hookPath, `#!/bin/sh\n\n${block}`, { mode: 0o755 })
    } else {
      const existing = await readFile(hookPath, 'utf8')
      const separator = existing.endsWith('\n') ? '\n' : '\n\n'
      await writeFile(hookPath, `${existing}${separator}${block}`)
    }
    await chmod(hookPath, 0o755).catch(() => undefined)
    installed.push(hookPath)
  }

  return { ok: true, installed }
}
