import { describe, expect, it } from 'vitest'
import { isSecretKey, REDACTED, redactSecrets } from '../../src/server/security/redaction.js'

describe('redactSecrets', () => {
  it('removes every sentinel held under a secret key, at any depth', () => {
    const input = {
      Authorization: 'Bearer SENTINEL_A',
      nested: {
        token: 'SENTINEL_B',
        GITHUB_TOKEN: 'SENTINEL_C',
        keep: 'visible-value',
      },
      list: [{ password: 'SENTINEL_D' }, { note: 'ok' }],
      apiKey: 'SENTINEL_E',
      'set-cookie': ['SENTINEL_F', 'SENTINEL_G'],
    }

    const serialized = JSON.stringify(redactSecrets(input))

    for (const sentinel of [
      'SENTINEL_A',
      'SENTINEL_B',
      'SENTINEL_C',
      'SENTINEL_D',
      'SENTINEL_E',
      'SENTINEL_F',
      'SENTINEL_G',
    ]) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(serialized).toContain('visible-value')
    expect(serialized).toContain('"note":"ok"')
    expect(serialized.split(REDACTED).length - 1).toBeGreaterThanOrEqual(6)
  })

  it('matches secret keys case-insensitively', () => {
    expect(isSecretKey('Authorization')).toBe(true)
    expect(isSecretKey('OPENAI_API_KEY')).toBe(true)
    expect(isSecretKey('Api_Key')).toBe(true)
    expect(isSecretKey('username')).toBe(false)
  })

  it('passes through primitives and null unchanged', () => {
    expect(redactSecrets('plain string')).toBe('plain string')
    expect(redactSecrets(42)).toBe(42)
    expect(redactSecrets(null)).toBeNull()
  })

  it('does not mutate the input object', () => {
    const input = { token: 'SENTINEL' }
    redactSecrets(input)
    expect(input.token).toBe('SENTINEL')
  })
})
