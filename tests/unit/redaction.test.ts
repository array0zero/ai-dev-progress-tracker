import { describe, expect, it } from 'vitest'
import {
  containsHighConfidenceSecret,
  isSecretKey,
  REDACTED,
  redactHighConfidenceSecrets,
  redactSecrets,
} from '../../src/server/security/redaction.js'

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

describe('high-confidence scanner (negative gate)', () => {
  const NL = String.fromCharCode(10)
  // 保存面へ入り込みうる形の偽 token。scanner は必ず検知しなければならない。
  const injected: Array<[string, string]> = [
    ['github token', 'ghp_0123456789abcdefghijABCDEFGHIJKL'],
    ['github pat', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'],
    ['openai key', 'sk-0123456789abcdefghijklmn'],
    ['anthropic key', 'sk-ant-0123456789abcdefghij'],
    ['aws access key id', 'AKIA0123456789ABCDEF'],
    [
      'pem private key',
      ['-----BEGIN PRIVATE KEY-----', 'MIIkeymaterial0000', '-----END PRIVATE KEY-----'].join(NL),
    ],
    ['password key-value', 'password=hunter2superSecretValue'],
    ['url credential', 'https://deploy:sup3rSecretPw@registry.example.com'],
  ]

  for (const [label, secret] of injected) {
    it(`fails the scan when a ${label} is injected into a stored surface`, () => {
      const surface = ['commit message', secret, 'more text'].join(NL)
      expect(containsHighConfidenceSecret(surface)).toBe(true)
      const redacted = redactHighConfidenceSecrets(surface)
      expect(redacted).not.toContain(secret)
      expect(containsHighConfidenceSecret(redacted)).toBe(false)
    })
  }

  it('leaves ordinary text alone', () => {
    const text = ['feat(dashboard): 8件を1画面へ並べる', 'refs #123'].join(NL)
    expect(containsHighConfidenceSecret(text)).toBe(false)
    expect(redactHighConfidenceSecrets(text)).toBe(text)
  })
})
