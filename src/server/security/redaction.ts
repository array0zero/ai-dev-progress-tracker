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

// --- high-confidence pattern scanner ---------------------------------------
//
// DESIGN.md「秘密情報の扱い」: DB へ保存する commit message / patch、Issue/PR の
// title/body へ保存前に適用する。長さ切り詰めより前に実行すること。
// 置換は型に関係なく [REDACTED]。

const KV_SECRET_NAMES =
  'password|passwd|token|access_token|refresh_token|api_key|apikey|secret|client_secret|access_key'

// すべての可変長量指定子に上限を付け、長い連続文字列に対する
// catastrophic backtracking を避ける。
const HIGH_CONFIDENCE_PATTERNS: readonly RegExp[] = [
  // GitHub classic / fine-grained token
  /gh[pousr]_[A-Za-z0-9]{20,255}/g,
  /github_pat_[A-Za-z0-9_]{20,255}/g,
  // Anthropic-style key (sk-ant-) は OpenAI-style より先に処理する
  /sk-ant-[A-Za-z0-9_-]{16,255}/g,
  // OpenAI-style key
  /sk-[A-Za-z0-9_-]{16,255}/g,
  // AWS access key ID
  /AKIA[0-9A-Z]{16}/g,
  // PEM private key block
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
]

const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi
const URL_QUERY_SECRET_PATTERN = new RegExp(`([?&](?:${KV_SECRET_NAMES})=)([^&\\s]{1,512})`, 'gi')
const KEY_VALUE_PATTERN = new RegExp(
  `\\b(${KV_SECRET_NAMES})\\b(["']?\\s{0,4}[:=]\\s{0,4}["']?)([^\\s"',;}&]{1,512})`,
  'gi',
)

// 既に redaction 済みの値を再マッチしないためのガード。
// value 側の量指定子は空白を跨げるため、直後に非空白が続くと `[REDACTED]` を含む
// 区間ごと再置換してしまい redaction が非冪等になる。先頭が marker なら据え置く。
function redactValue(prefix: string, value: string): string {
  return value.startsWith(REDACTED) ? `${prefix}${value}` : `${prefix}${REDACTED}`
}

/**
 * high-confidence な秘密情報パターンを [REDACTED] へ置換した文字列を返す。
 * 冪等: redact(redact(x)) === redact(x)。
 */
export function redactHighConfidenceSecrets(text: string): string {
  let output = text
  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    output = output.replace(pattern, REDACTED)
  }
  output = output.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}@`)
  output = output.replace(URL_QUERY_SECRET_PATTERN, (_match, prefix: string, value: string) =>
    redactValue(prefix, value),
  )
  output = output.replace(KEY_VALUE_PATTERN, (_match, name: string, sep: string, value: string) =>
    redactValue(`${name}${sep}`, value),
  )
  return output
}

export function containsHighConfidenceSecret(text: string): boolean {
  return redactHighConfidenceSecrets(text) !== text
}
