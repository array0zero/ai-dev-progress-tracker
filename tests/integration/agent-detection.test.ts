import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentEvent } from '../../src/cli/commands/agent-event.js'
import { type AppConfig, loadConfig } from '../../src/server/config.js'
import { listCandidates } from '../../src/server/db/candidate-repository.js'
import { insertProject } from '../../src/server/db/project-repository.js'
import { createTempDir, createTempRepo, type TempDir, type TempRepo } from '../helpers/temp-repo.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

const SECRET_TEXT = 'do not store this prompt body'

function codexEvent(cwd: string, type = 'agent-turn-complete'): string {
  return JSON.stringify({
    type,
    'turn-id': 'turn-1',
    cwd,
    'input-messages': [SECRET_TEXT],
    'last-assistant-message': SECRET_TEXT,
  })
}

function claudeEvent(cwd: string, event = 'UserPromptSubmit'): string {
  return JSON.stringify({
    hook_event_name: event,
    session_id: 'session-1',
    transcript_path: 'C:/transcripts/session-1.jsonl',
    cwd,
    prompt: SECRET_TEXT,
  })
}

describe('agent event detection', () => {
  let ctx: TestDb
  let config: AppConfig
  let opened: string[]
  let dataDir: TempDir

  const options = (overrides: Record<string, unknown> = {}) => ({
    config,
    db: ctx.db,
    ensureServer: async () => true,
    openUrl: async (url: string) => {
      opened.push(url)
      return true
    },
    ...overrides,
  })

  beforeEach(() => {
    ctx = createTestDb()
    dataDir = createTempDir('adpt-agent-data-')
    config = { ...loadConfig({ TRACKER_DATA_DIR: dataDir.root, TRACKER_PORT: '4317' }) }
    opened = []
  })

  afterEach(() => {
    ctx.cleanup()
    dataDir.cleanup()
  })

  it('creates a candidate and opens the prompt for a first Codex event outside Git', async () => {
    const folder = createTempDir()
    try {
      const code = await runAgentEvent(
        { agent: 'codex', input: 'argv', payload: codexEvent(folder.root) },
        options(),
      )
      expect(code).toBe(0)

      const candidates = listCandidates(ctx.db)
      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toMatchObject({
        localPath: realpathSync.native(folder.root),
        agent: 'codex',
        status: 'prompted',
      })
      expect(opened).toEqual([`http://127.0.0.1:4317/?candidate=${candidates[0]?.id}`])
    } finally {
      folder.cleanup()
    }
  })

  it('creates a candidate from a Claude stdin event', async () => {
    const folder = createTempDir()
    try {
      const code = await runAgentEvent(
        { agent: 'claude', input: 'stdin' },
        options({ readStdin: async () => claudeEvent(folder.root) }),
      )
      expect(code).toBe(0)
      expect(listCandidates(ctx.db)[0]).toMatchObject({
        localPath: realpathSync.native(folder.root),
        agent: 'claude',
        status: 'prompted',
      })
    } finally {
      folder.cleanup()
    }
  })

  it('uses the Git top level for an event fired from a subdirectory', async () => {
    let repo: TempRepo | null = null
    try {
      repo = createTempRepo()
      const sub = join(repo.root, 'packages', 'app')
      mkdirSync(sub, { recursive: true })

      expect(
        await runAgentEvent({ agent: 'codex', input: 'argv', payload: codexEvent(sub) }, options()),
      ).toBe(0)

      const topLevel = execFileSync('git', ['-C', sub, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim()
      expect(listCandidates(ctx.db)[0]?.localPath).toBe(realpathSync.native(topLevel))
    } finally {
      repo?.cleanup()
    }
  })

  it('keeps a single candidate for ten events on the same folder', async () => {
    const folder = createTempDir()
    try {
      for (let i = 0; i < 10; i += 1) {
        await runAgentEvent(
          {
            agent: i % 2 === 0 ? 'codex' : 'claude',
            input: 'argv',
            payload: codexEvent(folder.root),
          },
          options(),
        )
      }
      expect(listCandidates(ctx.db)).toHaveLength(1)
      // 登録確認は最初の 1 回だけ開く
      expect(opened).toHaveLength(1)
    } finally {
      folder.cleanup()
    }
  })

  it('does nothing for empty input, an unrelated event type or a missing cwd', async () => {
    const folder = createTempDir()
    try {
      const cases: Array<[Parameters<typeof runAgentEvent>[0], Record<string, unknown>]> = [
        [{ agent: 'codex', input: 'argv', payload: '' }, {}],
        [{ agent: 'codex', input: 'argv', payload: 'not json' }, {}],
        [
          { agent: 'codex', input: 'argv', payload: codexEvent(folder.root, 'agent-turn-start') },
          {},
        ],
        [{ agent: 'claude', input: 'stdin' }, { readStdin: async () => '' }],
        [
          { agent: 'claude', input: 'stdin' },
          { readStdin: async () => claudeEvent(folder.root, 'SessionStart') },
        ],
        [
          {
            agent: 'codex',
            input: 'argv',
            payload: JSON.stringify({ type: 'agent-turn-complete' }),
          },
          {},
        ],
        [
          {
            agent: 'codex',
            input: 'argv',
            payload: JSON.stringify({ type: 'agent-turn-complete', cwd: 'relative/path' }),
          },
          {},
        ],
        [
          {
            agent: 'codex',
            input: 'argv',
            payload: codexEvent(join(folder.root, 'missing-folder')),
          },
          {},
        ],
      ]
      for (const [args, overrides] of cases) {
        expect(await runAgentEvent(args, options(overrides))).toBe(0)
      }
      expect(listCandidates(ctx.db)).toEqual([])
      expect(opened).toEqual([])
    } finally {
      folder.cleanup()
    }
  })

  it('does not create a candidate for an already registered project', async () => {
    let repo: TempRepo | null = null
    try {
      repo = createTempRepo()
      const id = randomUUID()
      insertProject(ctx.db, {
        id,
        name: 'registered',
        localPath: realpathSync.native(repo.root),
        repoNodeId: `NODE_${id}`,
        repoOwner: 'octo',
        repoName: 'registered',
        repoUrl: 'https://github.com/octo/registered',
        defaultBranch: 'main',
        status: 'active',
      })

      expect(
        await runAgentEvent(
          { agent: 'codex', input: 'argv', payload: codexEvent(repo.root) },
          options(),
        ),
      ).toBe(0)
      expect(listCandidates(ctx.db)).toEqual([])
      expect(opened).toEqual([])
    } finally {
      repo?.cleanup()
    }
  })

  it('leaves the candidate unprompted when the browser cannot be opened', async () => {
    const folder = createTempDir()
    try {
      await runAgentEvent(
        { agent: 'codex', input: 'argv', payload: codexEvent(folder.root) },
        options({ openUrl: async () => false }),
      )
      expect(listCandidates(ctx.db)[0]?.status).toBe('detected')

      // 次の event で再度 prompt を試みる
      await runAgentEvent(
        { agent: 'codex', input: 'argv', payload: codexEvent(folder.root) },
        options(),
      )
      expect(listCandidates(ctx.db)[0]?.status).toBe('prompted')
      expect(opened).toHaveLength(1)
    } finally {
      folder.cleanup()
    }
  })

  it('stores neither prompt bodies nor transcript paths in the database or the log', async () => {
    const folder = createTempDir()
    try {
      await runAgentEvent(
        { agent: 'claude', input: 'stdin' },
        options({ readStdin: async () => claudeEvent(folder.root) }),
      )

      const dump = ctx.db
        .prepare("SELECT group_concat(sql, '\n') FROM sqlite_master WHERE type = 'table'")
        .pluck()
        .get() as string
      const rows = JSON.stringify(listCandidates(ctx.db))
      const log = readFileSync(config.logFilePath, 'utf8')

      for (const haystack of [dump, rows, log]) {
        expect(haystack).not.toContain(SECRET_TEXT)
        expect(haystack).not.toContain('transcript')
        expect(haystack).not.toContain('session-1')
      }
    } finally {
      folder.cleanup()
    }
  })
})
