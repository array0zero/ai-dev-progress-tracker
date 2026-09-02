import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  /** `gh api user --jq .login` の出力 */
  login?: string
  /** exit code for `gh repo create ...` */
  repoCreateExitCode?: number
  /** fallback data when a slug is not in `repos` */
  repoView?: Record<string, unknown>
  issues?: unknown[]
  pulls?: unknown[]
  /** per `owner/repo` data */
  repos?: Record<string, FakeRepoData>
  /**
   * `gh repo create --source <path> --remote origin` の実体を置くディレクトリ。
   * 指定すると bare repo を作って origin に張るので、push / ls-remote が実 Git で往復できる。
   */
  createRemoteDir?: string
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
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

if (c0 === 'auth' && c1 === 'setup-git') {
  process.exit(0)
}

if (c0 === 'api' && c1 === 'user') {
  process.stdout.write(fixtures.login ?? 'fake-user')
  process.exit(0)
}

if (c0 === 'repo' && c1 === 'create') {
  const exitCode = fixtures.repoCreateExitCode ?? 0
  if (exitCode !== 0) process.exit(exitCode)
  const created = argv[2]
  let url = 'https://github.com/' + created
  const sourceIndex = argv.indexOf('--source')
  if (fixtures.createRemoteDir) {
    const bare = join(fixtures.createRemoteDir, created.replace('/', '__') + '.git')
    mkdirSync(bare, { recursive: true })
    execFileSync('git', ['init', '--bare', '-b', 'main', bare])
    url = bare
    if (sourceIndex !== -1 && argv[sourceIndex + 1]) {
      execFileSync('git', ['-C', argv[sourceIndex + 1], 'remote', 'add', 'origin', bare])
    }
  }
  fixtures.repos = fixtures.repos ?? {}
  fixtures.repos[created] = {
    repoView: {
      id: 'NODE_' + created.replace('/', '_'),
      nameWithOwner: created,
      url,
      visibility: 'PRIVATE',
      defaultBranchRef: { name: 'main' },
      description: null,
    },
  }
  writeFileSync(process.env.FAKE_GH_FIXTURES, JSON.stringify(fixtures))
  process.exit(0)
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

export interface WrittenFakeGh {
  env: Record<string, string>
  fixturesPath: string
  callsPath: string
}

/** 指定ディレクトリへ fake gh 一式を書き出し、adapter 用の env を返す。 */
export function writeFakeGh(dir: string, fixtures: FakeGhFixtures = {}): WrittenFakeGh {
  mkdirSync(dir, { recursive: true })
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
    fixturesPath,
    callsPath,
  }
}

/** fixtures ファイルへ 1 リポジトリ分の repoView を追記する (E2E から実行時に追加する用)。 */
export function addRepoFixture(
  fixturesPath: string,
  slug: string,
  repoView: Record<string, unknown>,
): void {
  const current = JSON.parse(readFileSync(fixturesPath, 'utf8')) as FakeGhFixtures
  current.repos = { ...current.repos, [slug]: { repoView } }
  writeFileSync(fixturesPath, JSON.stringify(current))
}

export function createFakeGh(fixtures: FakeGhFixtures = {}): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
  const written = writeFakeGh(dir, fixtures)
  return {
    env: written.env,
    calls: () =>
      readFileSync(written.callsPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[]),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
