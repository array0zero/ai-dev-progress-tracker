import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempRepo {
  /** working tree root */
  root: string
  /** parent dir that holds the repo (and linked worktrees) */
  parent: string
  git: (...args: string[]) => string
  cleanup: () => void
}

export interface TempRepoOptions {
  origin?: string
  hooksPath?: string
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

export function createTempRepo(options: TempRepoOptions = {}): TempRepo {
  const parent = mkdtempSync(join(tmpdir(), 'adpt-repo-'))
  const root = join(parent, 'repo')
  mkdirSync(root)

  const git = (...args: string[]): string => runGit(root, args)
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test User')
  git('config', 'commit.gpgsign', 'false')
  if (options.origin !== undefined) {
    git('remote', 'add', 'origin', options.origin)
  }
  if (options.hooksPath !== undefined) {
    git('config', 'core.hooksPath', options.hooksPath)
  }

  writeFileSync(join(root, 'README.md'), '# temp repo\n')
  git('add', '.')
  git('commit', '-m', 'initial commit')

  return {
    root,
    parent,
    git,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  }
}
