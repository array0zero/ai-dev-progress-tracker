/**
 * UI 性能評価 harness。CI では実行しない。
 *
 * 使い方:
 *   npm run eval:ui -- --dry-run     # seed + server + identity 確認まで (計測しない)
 *   npm run eval:ui                  # 1 run 計測して JSON を stdout へ
 *   npm run eval:ui -- --empty       # 0 件 mode
 *   npm run eval:ui:record           # 5 run 計測して observed fixture を書く (T022)
 *
 * 隔離条件 (DESIGN「評価script隔離」):
 * - `TRACKER_DATA_DIR` は OS temp、`TRACKER_PORT` は 4318 固定 (使用中なら fail、別portへ逃げない)。
 * - fixture SQLite と temp Git repo だけを使い、対象 repo の working tree / DB を書き換えない。
 * - viewport は受入値 `2005x1271` 固定。
 * - 期待値はこの script に埋め込まない。threshold 判定は T022 の record mode が行う。
 */

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { loadConfig } from '../src/server/config.js'
import { openDatabase } from '../src/server/db/connection.js'
import { insertSnapshot } from '../src/server/db/progress-repository.js'
import { insertProject } from '../src/server/db/project-repository.js'
import { insertRun, upsertCommit } from '../src/server/db/run-repository.js'

export const EVAL_PORT = 4318
export const VIEWPORT = { width: 2005, height: 1271 }
export const PROJECT_COUNT = 8
/** PLAN の受入 threshold。実測値ではなくこの上限だけを事前固定する。 */
export const THRESHOLDS = { initialRenderMs: 2_000, searchMs: 500, filterMs: 500 }
export const RECORD_RUNS = 5
export const OBSERVED_FIXTURE_PATH = 'tests/fixtures/ui-performance-observed.json'
const SERVER_READY_TIMEOUT_MS = 30_000
const STEP_TIMEOUT_MS = 30_000

/** 実利用に近い長さの本文。1 行に収まらない現在地 / 次の作業を作る。 */
function currentPositionText(index: number): string {
  return `フェーズ${index + 1}: dashboard の一覧 API と生成 worker の接続まで完了し、現在は commit 検知から進捗生成までの経路を実データで確認している段階。`
}

function nextActionText(index: number): string {
  return `次は project ${index + 1} の backup export を v2 形式へ切り替え、restore 後の論理項目一致を確認する。`
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function assertPortFree(port: number): void {
  const server = createServer()
  let inUse = false
  server.on('error', () => {
    inUse = true
  })
  try {
    server.listen(port, '127.0.0.1')
  } catch {
    inUse = true
  }
  server.close()
  if (inUse) {
    throw new Error(`port ${port} is already in use; not falling back to another port`)
  }
}

export interface SeededProject {
  id: string
  name: string
  localPath: string
  headSha: string
}

/** temp Git repo を 8 件作り、その HEAD を持つ project + snapshot を temp DB へ seed する。 */
export function seedFixture(dataDir: string, reposDir: string, count: number): SeededProject[] {
  const db = openDatabase(loadConfig({ TRACKER_DATA_DIR: dataDir }).dbPath)
  const seeded: SeededProject[] = []
  try {
    for (let index = 0; index < count; index += 1) {
      const root = join(reposDir, `project-${index}`)
      execFileSync('git', ['init', '-b', 'main', root])
      git(root, 'config', 'user.email', 'eval@example.com')
      git(root, 'config', 'user.name', 'tracker eval')
      git(root, 'config', 'commit.gpgsign', 'false')
      writeFileSync(join(root, 'README.md'), `# project ${index}\n`)
      git(root, 'add', '.')
      git(root, 'commit', '-m', `seed ${index}`)
      const headSha = git(root, 'rev-parse', 'HEAD')

      const projectId = randomUUID()
      const name = `Eval Project ${String(index).padStart(2, '0')}`
      insertProject(
        db,
        {
          id: projectId,
          name,
          localPath: root,
          repoNodeId: `NODE_${projectId}`,
          repoOwner: 'eval',
          repoName: `project-${index}`,
          repoUrl: `https://github.com/eval/project-${index}`,
          defaultBranch: 'main',
          status: 'active',
          summary: `評価用 project ${index} の概要。dashboard 表示の密度を実利用に近づけるための本文。`,
          registrationSource: index % 2 === 0 ? 'codex' : 'claude',
          reviewRequired: index % 3 === 0,
        },
        new Date(`2026-09-0${(index % 8) + 1}T00:00:00.000Z`),
      )
      upsertCommit(db, {
        projectId,
        sha: headSha,
        parentSha: null,
        message: `seed ${index}`,
        authoredAt: '2026-09-01T00:00:00.000Z',
        detectedAt: `2026-09-0${(index % 8) + 1}T00:00:00.000Z`,
      })
      const runId = randomUUID()
      insertRun(db, {
        id: runId,
        dedupeKey: `generation:${projectId}:${headSha}`,
        projectId,
        commitSha: headSha,
        mode: 'generation',
        trigger: 'post_commit',
        detectedAt: `2026-09-0${(index % 8) + 1}T00:00:01.000Z`,
      })
      db.prepare("UPDATE generation_runs SET status = 'succeeded' WHERE id = ?").run(runId)
      insertSnapshot(
        db,
        {
          id: randomUUID(),
          generationRunId: runId,
          projectId,
          commitSha: headSha,
          recoveryStatus: 'complete',
          currentPosition: {
            status: 'confirmed',
            text: currentPositionText(index),
            evidenceIds: [],
          },
          completedItems: { status: 'needs_input', items: [], evidenceIds: [] },
          nextActions:
            index % 2 === 0
              ? {
                  status: 'confirmed',
                  items: [{ text: nextActionText(index), evidenceIds: [] }],
                  evidenceIds: [],
                }
              : { status: 'needs_input', items: [], evidenceIds: [] },
          decisions: { status: 'needs_input', items: [], evidenceIds: [] },
        },
        new Date(`2026-09-0${(index % 8) + 1}T00:00:02.000Z`),
      )
      seeded.push({ id: projectId, name, localPath: root, headSha })
    }
  } finally {
    db.close()
  }
  return seeded
}

async function waitForHealth(port: number): Promise<boolean> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
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

export interface UiMeasurement {
  initialRenderMs: number
  searchMs: number
  filterMs: number
  projectCount: number
  viewport: typeof VIEWPORT
  startedAt: string
}

export interface RunOptions {
  empty?: boolean
  dryRun?: boolean
}

/** 1 run 分の計測。seed / server 起動 / identity 確認 / 計測 / 後始末をまとめて行う。 */
export async function runOnce(options: RunOptions = {}): Promise<UiMeasurement | null> {
  const serverEntry = resolve(process.cwd(), 'dist/server/index.js')
  if (!existsSync(serverEntry)) {
    throw new Error('run "npm run build" first: dist/server/index.js is missing')
  }
  assertPortFree(EVAL_PORT)

  const dataDir = mkdtempSync(join(tmpdir(), 'adpt-eval-ui-data-'))
  const reposDir = mkdtempSync(join(tmpdir(), 'adpt-eval-ui-repos-'))
  const count = options.empty === true ? 0 : PROJECT_COUNT
  const seeded = seedFixture(dataDir, reposDir, count)

  const server = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      TRACKER_DATA_DIR: dataDir,
      TRACKER_PORT: String(EVAL_PORT),
    },
    stdio: 'ignore',
  })

  const browser = await chromium.launch()
  try {
    if (!(await waitForHealth(EVAL_PORT))) {
      throw new Error('the evaluation server did not become healthy')
    }

    const page = await browser.newPage({ viewport: VIEWPORT })
    const base = `http://127.0.0.1:${EVAL_PORT}`

    // 外部往復: 実 Git の HEAD と API / DOM の identity が一致してから計測する。
    const apiProjects = (await (await fetch(`${base}/api/projects`)).json()) as Array<{
      id: string
      name: string
      latestCommitSha: string | null
    }>
    if (apiProjects.length !== count) {
      throw new Error(`API returned ${apiProjects.length} projects, expected ${count}`)
    }
    for (const project of seeded) {
      const fromApi = apiProjects.find((item) => item.id === project.id)
      const fromGit = git(project.localPath, 'rev-parse', 'HEAD')
      if (fromApi === undefined || fromApi.latestCommitSha !== fromGit) {
        throw new Error(`identity mismatch for ${project.name}`)
      }
    }

    const rows = page.locator('.dense-row')
    const startedAt = new Date().toISOString()

    const navigationStart = Date.now()
    await page.goto(`${base}/`, { waitUntil: 'commit' })
    if (count > 0) {
      await rows.nth(count - 1).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    } else {
      await page
        .getByText('登録済みプロジェクトはありません。')
        .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    }
    const initialRenderMs = Date.now() - navigationStart

    if (count > 0) {
      const domNames = await page.locator('.dense-row__name').allTextContents()
      for (const project of seeded) {
        if (!domNames.includes(project.name)) {
          throw new Error(`DOM does not show ${project.name}`)
        }
      }
    }

    if (options.dryRun === true) {
      await page.close()
      return null
    }

    // 検索: input event から結果確定まで
    const searchStart = Date.now()
    await page.getByLabel('検索').fill('Eval Project 03')
    if (count > 0) {
      await page.waitForFunction(
        () => document.querySelectorAll('.dense-row').length === 1,
        undefined,
        { timeout: STEP_TIMEOUT_MS },
      )
    } else {
      await page.waitForFunction(
        () => document.querySelectorAll('.dense-row').length === 0,
        undefined,
        { timeout: STEP_TIMEOUT_MS },
      )
    }
    const searchMs = Date.now() - searchStart

    await page.getByLabel('検索').fill('')
    if (count > 0) {
      await page.waitForFunction(
        (expected) => document.querySelectorAll('.dense-row').length === expected,
        count,
        { timeout: STEP_TIMEOUT_MS },
      )
    }

    // 絞り込み: click から結果確定まで
    const filterStart = Date.now()
    await page.getByLabel('次の作業あり').check()
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.dense-row').length === expected,
      count === 0 ? 0 : Math.ceil(count / 2),
      { timeout: STEP_TIMEOUT_MS },
    )
    const filterMs = Date.now() - filterStart

    await page.close()
    return {
      initialRenderMs,
      searchMs,
      filterMs,
      projectCount: count,
      viewport: VIEWPORT,
      startedAt,
    }
  } finally {
    await browser.close()
    // server が SQLite を掴んだままだと Windows で temp が消せないため、終了を待つ。
    const exited = new Promise<void>((done) => {
      server.once('exit', () => done())
      setTimeout(done, 5_000).unref()
    })
    server.kill()
    await exited
    for (const dir of [dataDir, reposDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}

/**
 * 5 run + 0 件 run を実測し、その出力をそのまま fixture へ書く (手書き禁止)。
 * 各 run が threshold 以下のときだけ pass。失敗しても threshold は緩めない。
 */
export async function recordObservations(): Promise<{ ok: boolean; report: unknown }> {
  const runs: UiMeasurement[] = []
  for (let index = 0; index < RECORD_RUNS; index += 1) {
    const measurement = await runOnce()
    if (measurement === null) {
      throw new Error('measurement returned no result')
    }
    runs.push(measurement)
  }
  const emptyRun = await runOnce({ empty: true })

  const withinThreshold = (run: UiMeasurement): boolean =>
    run.initialRenderMs <= THRESHOLDS.initialRenderMs &&
    run.searchMs <= THRESHOLDS.searchMs &&
    run.filterMs <= THRESHOLDS.filterMs

  const passedRuns = runs.filter(withinThreshold).length
  const ok = passedRuns === RECORD_RUNS && emptyRun !== null && withinThreshold(emptyRun)
  const report = {
    tool: 'eval:ui:record',
    recordedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    projectCount: PROJECT_COUNT,
    thresholds: THRESHOLDS,
    runs,
    emptyRun,
    passedRuns,
    totalRuns: RECORD_RUNS,
    pass: ok,
  }

  const target = resolve(process.cwd(), OBSERVED_FIXTURE_PATH)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    `${JSON.stringify(report, null, 2)}
`,
    'utf8',
  )
  return { ok, report }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      empty: { type: 'boolean' },
      record: { type: 'boolean' },
    },
    strict: false,
  })

  if (values.record === true) {
    const recorded = await recordObservations()
    process.stdout.write(`${JSON.stringify(recorded.report, null, 2)}
`)
    return recorded.ok ? 0 : 1
  }

  const dryRun = values['dry-run'] === true
  const measurement = await runOnce({ dryRun, empty: values.empty === true })
  process.stdout.write(
    `${JSON.stringify(
      {
        tool: 'eval:ui',
        dryRun,
        empty: values.empty === true,
        viewport: VIEWPORT,
        measurement,
      },
      null,
      2,
    )}\n`,
  )
  return 0
}

// record mode (T022) から import されたときは実行しない。
if (process.argv[1]?.endsWith('eval-ui-performance.ts') === true) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
