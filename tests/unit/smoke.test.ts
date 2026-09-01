import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/server/config.js'

describe('smoke', () => {
  it('serves GET /api/health', async () => {
    const app = await buildApp({ config: loadConfig({ TRACKER_DATA_DIR: '', TRACKER_PORT: '' }) })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ status: 'ok', db: 'ok' })
    } finally {
      await app.close()
    }
  })

  it('fixes the loopback bind host', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1')
  })
})
