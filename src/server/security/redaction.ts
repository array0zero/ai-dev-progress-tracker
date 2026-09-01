/**
 * DESIGN.md「秘密情報の扱い」のキー名一覧。case-insensitive で照合する。
 * 一致したキーの値は型に関係なく [REDACTED] へ置換する。
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'password',
  'secret',
  'openai_api_key',
  'gh_token',
  'github_token',
  'anthropic_api_key',
])

export const REDACTED = '[REDACTED]'

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase())
}

/** オブジェクト/配列を再帰的に走査し、秘密キーの値を [REDACTED] へ置換した複製を返す。 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item))
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSecretKey(key) ? REDACTED : redactSecrets(child)
    }
    return result
  }
  return value
}
