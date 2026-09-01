/**
 * 秘密情報 0 件検査。
 *
 * GitHub / OpenAI / Anthropic / AWS / PEM / password / token の sentinel を
 * process env と evidence 到達コンテンツ (commit patch・Issue/PR 本文) へ置き、
 * 全機能 (project 登録・generation・backup export・logging) を実行してから
 * data dir 配下の全ファイルと backup export を走査する。1 件でも sentinel が
 * 残っていれば exit 1。
 *
 * 実 gh / 実 codex は呼ばず tests/helpers の fake を使う。
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { openDatabase } from '../src/server/db/connection.js'
import { getRunById } from '../src/server/db/run-repository.js'
import { createLogger } from '../src/server/logging.js'
import { createBackupExport, exportBackupData } from '../src/server/services/backup-service.js'
import {
  collectEvidenceBundle,
  enqueueGeneration,
  runGeneration,
} from '../src/server/services/generation-service.js'
import { registerProject } from '../src/server/services/project-service.js'
import { writeFakeCodex } from '../tests/helpers/fake-codex.js'
import { writeFakeGh } from '../tests/helpers/fake-gh.js'

// すべて大文字 SENTINEL を含み、かつ redaction pattern が反応する形にする。
const SENTINELS: Record<string, string> = {
  githubToken: 'ghp_SENTINEL0000abcdefghijklmnopqrstuvwx',
  openaiKey: 'sk-SENTINEL0000abcdefghijklmnop',
  anthropicKey: 'sk-ant-SENTINEL0000abcdefghijkl',
  awsKey: 'AKIASENTINEL0000ABCD',
  pemKey:
    '-----BEGIN PRIVATE KEY-----\nMIISENTINELkeymaterialAAAABBBBCCCCDDDD\n-----END PRIVATE KEY-----',
  passwordUrl: 'https://deploy:SENTINELpw9xZ@registry.example.com',
  tokenUrl: 'https://bot:SENTINELtok3n7yQ@api.example.com',
}

const ENV_SENTINELS: Record<string, string> = {
  OPENAI_API_KEY: SENTINELS.openaiKey,
  OPENAI_ORG_ID: 'org-SENTINEL-eb12',
  GH_TOKEN: SENTINELS.githubToken,
  GITHUB_TOKEN: SENTINELS.githubToken,
  ANTHROPIC_API_KEY: SENTINELS.anthropicKey,
  AWS_SECRET_ACCESS_KEY: 'awsSENTINELsecret2Ab9',
  TRACKER_TEST_PASSWORD: 'SENTINELenvPw77aa',
}

const NEEDLES: string[] = [
  ...new Set([...Object.values(SENTINELS), ...Object.values(ENV_SENTINELS)]),
  'SENTINELkeymaterial',
  'SENTINEL',
]

interface Hit {
  target: string
  needle: string
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

async function build(
  work: string,
): Promise<{ dataDir: string; rawExport: string; gatePassed: boolean }> {
  const dataDir = join(work, 'data')
  mkdirSync(dataDir, { recursive: true })

  const gh = writeFakeGh(join(work, 'gh'), {
    authStatusExitCode: 0,
    login: 'acme',
    repos: {
      'acme/widget': {
        repoView: {
          id: 'NODE_ACME_WIDGET',
          nameWithOwner: 'acme/widget',
          url: 'https://github.com/acme/widget',
          visibility: 'PRIVATE',
          defaultBranchRef: { name: 'main' },
        },
        issues: [
          {
            number: 7,
            title: 'Config rotation',
            state: 'OPEN',
            body: Object.values(SENTINELS).join('\n'),
            updatedAt: '2026-08-01T00:00:00Z',
            url: 'https://github.com/acme/widget/issues/7',
            labels: [],
          },
        ],
        pulls: [
          {
            number: 9,
            title: 'Rotate config',
            state: 'OPEN',
            body: Object.values(SENTINELS).join('\n'),
            updatedAt: '2026-08-02T00:00:00Z',
            mergedAt: null,
            url: 'https://github.com/acme/widget/pull/9',
            headRefName: 'rotate',
            baseRefName: 'main',
          },
        ],
      },
    },
  })
  const codex = writeFakeCodex(join(work, 'codex'), {})

  for (const [key, value] of Object.entries({
    ...ENV_SENTINELS,
    ...gh.env,
    ...codex.env,
    TRACKER_DATA_DIR: dataDir,
  })) {
    process.env[key] = value
  }

  const repo = join(work, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.email', 'verify@example.com')
  git('config', 'user.name', 'verify')
  git('config', 'commit.gpgsign', 'false')
  git('remote', 'add', 'origin', 'https://github.com/acme/widget.git')
  writeFileSync(join(repo, 'README.md'), '# widget\n')
  git('add', '.')
  git('commit', '-m', 'initial commit')
  // sentinel は commit message ではなく patch 到達コンテンツへ置く。
  writeFileSync(join(repo, 'config.env'), `${Object.values(SENTINELS).join('\n')}\n`)
  git('add', '.')
  git('commit', '-m', 'add config.env for rotation')

  const db = openDatabase(join(dataDir, 'tracker.db'))
  const logger = createLogger(join(dataDir, 'logs', 'app.log'))

  const registered = await registerProject(
    { name: 'acme/widget', localPath: repo, repository: 'acme/widget' },
    db,
    { autoRecover: false, autoBackup: false, spawnWorker: () => undefined },
  )
  if (!registered.ok) {
    throw new Error(`registration failed: ${registered.code}`)
  }
  const projectId = registered.project.id
  const sha = git('rev-parse', 'HEAD')

  const enqueued = enqueueGeneration(db, {
    projectId,
    sha,
    mode: 'generation',
    trigger: 'post_commit',
  })
  const run = getRunById(db, enqueued.runId)
  if (run === null) {
    throw new Error('generation run missing')
  }
  const bundle = await collectEvidenceBundle(db, run)
  const commitEvidence = bundle.evidence.find((item) => item.kind === 'commit')
  const evidenceId = commitEvidence?.id ?? bundle.evidence[0]?.id ?? randomUUID()
  const confirmed = {
    schemaVersion: 1,
    currentPosition: { status: 'confirmed', text: '現在の作業内容', evidenceIds: [evidenceId] },
    completedItems: {
      status: 'confirmed',
      items: [{ text: '項目', evidenceIds: [evidenceId] }],
      evidenceIds: [evidenceId],
    },
    nextActions: {
      status: 'confirmed',
      items: [{ text: '次の作業', evidenceIds: [evidenceId] }],
      evidenceIds: [evidenceId],
    },
    importantDecisions: {
      status: 'confirmed',
      items: [{ decision: '採用', rationale: '理由', evidenceIds: [evidenceId] }],
      evidenceIds: [evidenceId],
    },
  }
  writeFakeCodex(join(work, 'codex'), { output: confirmed })
  await runGeneration(db, run)
  logger.info('verify-no-secrets: generation finished', {
    runId: run.id,
    status: getRunById(db, run.id)?.status ?? null,
  })

  // backup export は「push される実バイト列」を走査する。gate (secret scanner) の
  // 合否は情報として別に記録する。
  const rawExport = exportBackupData(db).dataJson
  const gatePassed = createBackupExport(db).ok
  db.close()
  return { dataDir, rawExport, gatePassed }
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'verify-no-secrets-'))
  try {
    const { dataDir, rawExport, gatePassed } = await build(work)

    const targets: Array<{ name: string; text: string }> = [
      { name: 'backup-export:data/backup-v1.json', text: rawExport },
    ]
    for (const file of walkFiles(dataDir)) {
      targets.push({ name: relative(dataDir, file), text: readFileSync(file).toString('latin1') })
    }

    const hits: Hit[] = []
    for (const target of targets) {
      for (const needle of NEEDLES) {
        if (target.text.includes(needle)) {
          hits.push({ target: target.name, needle })
        }
      }
    }

    const report = {
      tool: 'verify:secrets',
      scannedTargets: targets.length,
      sentinelCount: NEEDLES.length,
      backupSecretGatePassed: gatePassed,
      hitCount: hits.length,
      hits,
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = hits.length === 0 ? 0 : 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
