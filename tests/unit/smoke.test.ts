import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'
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
