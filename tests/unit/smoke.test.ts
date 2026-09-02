import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import {
  checkVersion,
  extractVersion,
  loadConfig,
  VERSION_PARSE_ERROR,
  VERSION_REQUIREMENTS,
} from '../../src/server/config.js'
import { createTestDb } from '../helpers/test-db.js'

describe('smoke', () => {
  it('serves GET /api/health', async () => {
    const ctx = createTestDb()
    const app = await buildApp({
      config: loadConfig({ TRACKER_DATA_DIR: '', TRACKER_PORT: '' }),
      db: ctx.db,
    })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ status: 'ok', db: 'ok' })
    } finally {
      await app.close()
      ctx.cleanup()
    }
  })

  it('fixes the loopback bind host', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1')
  })
})

describe('version parser', () => {
  it('extracts the first three-part version from CLI output', () => {
    expect(extractVersion('v24.15.0')).toEqual([24, 15, 0])
    expect(extractVersion('git version 2.45.1.windows.1')).toEqual([2, 45, 1])
    expect(extractVersion('gh version 2.98.0 (2026-01-01)')).toEqual([2, 98, 0])
  })

  it('reports a parse error when no version is present', () => {
    expect(extractVersion('command not found')).toBeNull()
    expect(checkVersion('command not found', VERSION_REQUIREMENTS.git)).toEqual({
      ok: false,
      code: VERSION_PARSE_ERROR,
    })
  })

  it('accepts the exact minimum version', () => {
    expect(checkVersion('git version 2.45.0', VERSION_REQUIREMENTS.git).ok).toBe(true)
    expect(checkVersion('gh version 2.98.0', VERSION_REQUIREMENTS.gh).ok).toBe(true)
  })

  it('rejects one patch below the minimum version', () => {
    expect(checkVersion('git version 2.44.9', VERSION_REQUIREMENTS.git)).toEqual({
      ok: false,
      code: 'GIT_VERSION_UNSUPPORTED',
    })
    expect(checkVersion('gh version 2.97.9', VERSION_REQUIREMENTS.gh)).toEqual({
      ok: false,
      code: 'GH_VERSION_UNSUPPORTED',
    })
  })

  it('sets no upper bound on Git and gh', () => {
    expect(checkVersion('git version 9.0.0', VERSION_REQUIREMENTS.git).ok).toBe(true)
    expect(checkVersion('gh version 9.0.0', VERSION_REQUIREMENTS.gh).ok).toBe(true)
  })
})
