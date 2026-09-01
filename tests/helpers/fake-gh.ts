import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeRepoData {
  repoView?: Record<string, unknown>
  issues?: unknown[]
  pulls?: unknown[]
}

export interface FakeGhFixtures {
  /** exit code for `gh auth status ...` */
  authStatusExitCode?: number
  /** fallback data when a slug is not in `repos` */
  repoView?: Record<string, unknown>
  issues?: unknown[]
  pulls?: unknown[]
  /** per `owner/repo` data */
  repos?: Record<string, FakeRepoData>
}

export interface FakeGh {
  /** merge into process.env so the github adapter uses this fake */
  env: Record<string, string>
  /** every invocation's argv (without the node/script prefix) */
  calls: () => string[][]
  cleanup: () => void
}

// node が ESM として実行する fake gh 本体。argv に応じた固定 JSON を返し、呼び出しを記録する。
const FAKE_GH_SOURCE = `
import { appendFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const fixtures = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURES, 'utf8'))
appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(argv) + '\\n')

function slugFromArgs(args) {
  const dashR = args.indexOf('-R')
  if (dashR !== -1 && args[dashR + 1]) return args[dashR + 1]
  if (args[0] === 'repo' && args[1] === 'view' && args[2] && !args[2].startsWith('-')) return args[2]
  return null
}

const [c0, c1] = argv

if (c0 === 'auth' && c1 === 'status') {
  process.exit(fixtures.authStatusExitCode ?? 0)
}

const slug = slugFromArgs(argv)
const perRepo = (slug && fixtures.repos && fixtures.repos[slug]) || {}

if (c0 === 'repo' && c1 === 'view') {
  const view = perRepo.repoView ?? fixtures.repoView
  if (!view) {
    process.stderr.write('fake-gh: no repoView for ' + slug + '\\n')
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(view))
  process.exit(0)
}

if (c0 === 'issue' && c1 === 'list') {
  process.stdout.write(JSON.stringify(perRepo.issues ?? fixtures.issues ?? []))
  process.exit(0)
}

if (c0 === 'pr' && c1 === 'list') {
  process.stdout.write(JSON.stringify(perRepo.pulls ?? fixtures.pulls ?? []))
  process.exit(0)
}

process.stderr.write('fake-gh: unhandled command: ' + argv.join(' ') + '\\n')
process.exit(2)
`

export function createFakeGh(fixtures: FakeGhFixtures = {}): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
  const scriptPath = join(dir, 'fake-gh.mjs')
  const fixturesPath = join(dir, 'fixtures.json')
  const callsPath = join(dir, 'calls.jsonl')

  writeFileSync(scriptPath, FAKE_GH_SOURCE)
  writeFileSync(fixturesPath, JSON.stringify(fixtures))
  writeFileSync(callsPath, '')

  return {
    env: {
      TRACKER_GH_BIN: process.execPath,
      TRACKER_GH_ARGS: JSON.stringify([scriptPath]),
      FAKE_GH_FIXTURES: fixturesPath,
      FAKE_GH_CALLS: callsPath,
    },
    calls: () =>
      readFileSync(callsPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[]),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
