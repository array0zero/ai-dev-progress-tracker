import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  countRunEvidence,
  linkRunEvidence,
  listRunEvidencePayloads,
  upsertEvidence,
} from '../../src/server/db/progress-repository.js'
import { insertProject } from '../../src/server/db/project-repository.js'
import { insertRun, upsertCommit } from '../../src/server/db/run-repository.js'
import {
  containsHighConfidenceSecret,
  redactHighConfidenceSecrets,
} from '../../src/server/security/redaction.js'
import { createTestDb, type TestDb } from '../helpers/test-db.js'

const SENTINELS: Array<[string, string]> = [
  ['github classic token', 'ghp_0123456789abcdefghijABCDEFGHIJKL'],
  ['github fine-grained token', 'github_pat_0123456789abcdefghij_0123456789abcdefghij'],
  ['openai key', 'sk-0123456789abcdefghijklmnopqrstuv'],
  ['anthropic key', 'sk-ant-0123456789abcdefghijklmnop'],
  ['aws access key id', 'AKIAABCDEFGHIJKLMNOP'],
  ['key-value pair', 'api_key=SUPERSECRETVALUE123'],
  ['url credential', 'https://user:hunter2secret@example.com/x'],
]

const PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu
KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==
-----END RSA PRIVATE KEY-----`

describe('redactHighConfidenceSecrets', () => {
  for (const [name, sentinel] of SENTINELS) {
    it(`redacts a ${name}`, () => {
      const input = `context before ${sentinel} context after`
      const output = redactHighConfidenceSecrets(input)
      expect(output).not.toContain(sentinel)
      expect(output).toContain('[REDACTED]')
      expect(containsHighConfidenceSecret(input)).toBe(true)
    })
  }

  it('redacts a PEM private key block', () => {
    const output = redactHighConfidenceSecrets(`before\n${PEM}\nafter`)
    expect(output).not.toContain('MIIBOgIBAAJBAKj34')
    expect(output).toContain('[REDACTED]')
  })

  it('leaves benign text untouched', () => {
    const benign = 'Refactored the token bucket rate limiter; see PR #42 for details.'
    expect(redactHighConfidenceSecrets(benign)).toBe(benign)
    expect(containsHighConfidenceSecret(benign)).toBe(false)
  })

  it('is idempotent: redacting already-redacted text is a no-op', () => {
    for (const [, sentinel] of SENTINELS) {
      const once = redactHighConfidenceSecrets(`lead ${sentinel} tail`)
      expect(redactHighConfidenceSecrets(once)).toBe(once)
      expect(containsHighConfidenceSecret(once)).toBe(false)
    }
  })

  it('does not re-fire when [REDACTED] is followed by non-whitespace (serialized JSON)', () => {
    // 生テキストでは改行が量指定子を止めるが、JSON 直列化後は "\n" が
    // エスケープされ非空白になる。この形でも再マッチしてはならない。
    const raw = 'password=hunter2secret\ntoken=another-secret-value'
    const redacted = redactHighConfidenceSecrets(raw)
    expect(redacted).not.toContain('hunter2secret')
    expect(redacted).not.toContain('another-secret-value')

    const serialized = JSON.stringify({ body: redacted })
    expect(redactHighConfidenceSecrets(serialized)).toBe(serialized)
    expect(containsHighConfidenceSecret(serialized)).toBe(false)
  })
})

describe('evidence + run_evidence repository', () => {
  let ctx: TestDb
  let projectId: string
  let runId: string
  const sha = 'c'.repeat(40)

  beforeEach(() => {
    ctx = createTestDb()
    projectId = randomUUID()
    insertProject(ctx.db, {
      id: projectId,
      name: 'evidence-demo',
      localPath: `/seed/${projectId}`,
      repoNodeId: `NODE_${projectId}`,
      repoOwner: 'seed',
      repoName: 'demo',
      repoUrl: 'https://github.com/seed/demo',
      defaultBranch: 'main',
      status: 'active',
    })
    upsertCommit(ctx.db, {
      projectId,
      sha,
      parentSha: null,
      message: 'seed',
      authoredAt: '2026-09-01T00:00:00.000Z',
      detectedAt: '2026-09-01T00:00:01.000Z',
    })
    runId = randomUUID()
    insertRun(ctx.db, {
      id: runId,
      dedupeKey: `generation:${projectId}:${sha}`,
      projectId,
      commitSha: sha,
      mode: 'generation',
      trigger: 'post_commit',
      detectedAt: '2026-09-01T00:00:02.000Z',
    })
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('upserts by (project, kind, external_key, source_version) and keeps the same id', () => {
    const first = upsertEvidence(ctx.db, {
      projectId,
      kind: 'issue',
      externalKey: '7',
      sourceVersion: '2026-09-01T00:00:00.000Z',
      title: 'first title',
      url: 'https://github.com/seed/demo/issues/7',
      payload: { body: 'v1' },
      capturedAt: '2026-09-01T00:00:03.000Z',
    })
    const second = upsertEvidence(ctx.db, {
      projectId,
      kind: 'issue',
      externalKey: '7',
      sourceVersion: '2026-09-01T00:00:00.000Z',
      title: 'updated title',
      url: 'https://github.com/seed/demo/issues/7',
      payload: { body: 'v2' },
      capturedAt: '2026-09-01T00:00:04.000Z',
    })
    expect(second).toBe(first)

    linkRunEvidence(ctx.db, runId, [first])
    const payloads = listRunEvidencePayloads(ctx.db, runId)
    expect(payloads).toEqual([{ body: 'v2' }])
  })

  it('counts linked evidence and ignores duplicate links', () => {
    const ids = ['a', 'b', 'c'].map((key) =>
      upsertEvidence(ctx.db, {
        projectId,
        kind: 'commit',
        externalKey: key,
        sourceVersion: key,
        title: key,
        url: null,
        payload: {},
        capturedAt: '2026-09-01T00:00:03.000Z',
      }),
    )
    linkRunEvidence(ctx.db, runId, ids)
    linkRunEvidence(ctx.db, runId, ids)
    expect(countRunEvidence(ctx.db, runId)).toBe(3)
  })
})
