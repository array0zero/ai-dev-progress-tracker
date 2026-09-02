import { z } from 'zod'

const statusSchema = z.enum(['confirmed', 'needs_input'])
const evidenceIdsSchema = z.array(z.string())

const textFieldSchema = z.object({
  status: statusSchema,
  text: z.string(),
  evidenceIds: evidenceIdsSchema,
})

const listItemSchema = z.object({
  text: z.string(),
  evidenceIds: evidenceIdsSchema,
})

const listFieldSchema = z.object({
  status: statusSchema,
  items: z.array(listItemSchema),
  evidenceIds: evidenceIdsSchema,
})

const decisionItemSchema = z.object({
  decision: z.string(),
  rationale: z.string(),
  evidenceIds: evidenceIdsSchema,
})

const decisionFieldSchema = z.object({
  status: statusSchema,
  items: z.array(decisionItemSchema),
  evidenceIds: evidenceIdsSchema,
})

/** DESIGN.md「共通進捗情報の固定形式」を Zod で表現したもの。progress-output.schema.json と同義。 */
export const progressOutputSchema = z.object({
  schemaVersion: z.literal(1),
  currentPosition: textFieldSchema,
  completedItems: listFieldSchema,
  nextActions: listFieldSchema,
  importantDecisions: decisionFieldSchema,
})

export type ProgressOutput = z.infer<typeof progressOutputSchema>
export type ProgressFieldStatus = z.infer<typeof statusSchema>

export const NEEDS_INPUT_TEXT = '要補完'

export const PROGRESS_FIELD_KEYS = [
  'currentPosition',
  'completedItems',
  'nextActions',
  'importantDecisions',
] as const
export type ProgressFieldKey = (typeof PROGRESS_FIELD_KEYS)[number]

export type RecoveryStatus = 'complete' | 'partial' | 'unrecoverable'

export interface RecoveryClassification {
  runStatus: 'succeeded' | 'partial' | 'unrecoverable'
  recoveryStatus: RecoveryStatus
}

/** DESIGN.md: confirmed field 数 4 -> complete、1..3 -> partial、0 -> unrecoverable。 */
export function classifyByConfirmedCount(confirmedCount: number): RecoveryClassification {
  if (confirmedCount >= 4) {
    return { runStatus: 'succeeded', recoveryStatus: 'complete' }
  }
  if (confirmedCount >= 1) {
    return { runStatus: 'partial', recoveryStatus: 'partial' }
  }
  return { runStatus: 'unrecoverable', recoveryStatus: 'unrecoverable' }
}

/** status が needs_input の field 名一覧 (UI の不足項目表示用)。 */
export function missingFieldKeys(
  statuses: Record<ProgressFieldKey, ProgressFieldStatus>,
): ProgressFieldKey[] {
  return PROGRESS_FIELD_KEYS.filter((key) => statuses[key] === 'needs_input')
}

export type ProgressValidationResult =
  | { ok: true; progress: ProgressOutput; confirmedCount: number }
  | { ok: false; code: string; reason: string }

function invalid(reason: string): ProgressValidationResult {
  return { ok: false, code: 'CODEX_OUTPUT_INVALID', reason }
}

/**
 * Codex 出力を DESIGN.md の意味規則で検証する。
 * - status ごとの needs_input / confirmed 形式
 * - confirmed field / item は evidence を 1 件以上持つ (importantDecisions は field-level のみで items=[] を許可)
 * - 参照 evidence ID がすべて run_evidence に存在する
 */
export function validateProgressOutput(
  raw: unknown,
  availableEvidenceIds: ReadonlySet<string>,
): ProgressValidationResult {
  const parsed = progressOutputSchema.safeParse(raw)
  if (!parsed.success) {
    return invalid(
      `output does not match the progress contract: ${parsed.error.message.slice(0, 300)}`,
    )
  }
  const output = parsed.data
  const referenced = new Set<string>()

  // needs_input の field は「根拠が無い」という以外の情報を持たない。
  // モデルが付けた説明文 / evidenceId / item を落として固定形式へ正規化する。
  // これは推測の除去であり、推測の確定保存 (DESIGN D014) には当たらない。
  if (output.currentPosition.status === 'needs_input') {
    output.currentPosition = { status: 'needs_input', text: NEEDS_INPUT_TEXT, evidenceIds: [] }
  }
  for (const key of ['completedItems', 'nextActions'] as const) {
    if (output[key].status === 'needs_input') {
      output[key] = { status: 'needs_input', items: [], evidenceIds: [] }
    }
  }
  if (output.importantDecisions.status === 'needs_input') {
    output.importantDecisions = { status: 'needs_input', items: [], evidenceIds: [] }
  }

  const cp = output.currentPosition
  if (cp.status === 'needs_input') {
    if (cp.text !== NEEDS_INPUT_TEXT || cp.evidenceIds.length !== 0) {
      return invalid('currentPosition needs_input form is invalid')
    }
  } else {
    if (cp.text.trim() === '' || cp.text === NEEDS_INPUT_TEXT || cp.evidenceIds.length === 0) {
      return invalid('currentPosition confirmed form is invalid')
    }
    for (const id of cp.evidenceIds) {
      referenced.add(id)
    }
  }

  for (const key of ['completedItems', 'nextActions'] as const) {
    const field = output[key]
    if (field.status === 'needs_input') {
      if (field.items.length !== 0 || field.evidenceIds.length !== 0) {
        return invalid(`${key} needs_input form is invalid`)
      }
    } else {
      if (field.items.length === 0 || field.evidenceIds.length === 0) {
        return invalid(`${key} confirmed requires at least one item and field-level evidence`)
      }
      for (const item of field.items) {
        if (item.text.trim() === '' || item.evidenceIds.length === 0) {
          return invalid(`${key} item form is invalid`)
        }
        for (const id of item.evidenceIds) {
          referenced.add(id)
        }
      }
      for (const id of field.evidenceIds) {
        referenced.add(id)
      }
    }
  }

  const dec = output.importantDecisions
  if (dec.status === 'needs_input') {
    if (dec.items.length !== 0 || dec.evidenceIds.length !== 0) {
      return invalid('importantDecisions needs_input form is invalid')
    }
  } else {
    if (dec.evidenceIds.length === 0) {
      return invalid('importantDecisions confirmed requires field-level evidence')
    }
    // 形式不備の decision item は捨てる。field-level evidence があれば
    // items=[] の confirmed は許容されるため (DESIGN)、出力全体は失効させない。
    dec.items = dec.items.filter(
      (item) =>
        item.decision.trim() !== '' && item.rationale.trim() !== '' && item.evidenceIds.length > 0,
    )
    for (const item of dec.items) {
      for (const id of item.evidenceIds) {
        referenced.add(id)
      }
    }
    for (const id of dec.evidenceIds) {
      referenced.add(id)
    }
  }

  for (const id of referenced) {
    if (!availableEvidenceIds.has(id)) {
      return {
        ok: false,
        code: 'UNKNOWN_EVIDENCE_ID',
        reason: `output references evidence that is not in run_evidence: ${id}`,
      }
    }
  }

  const confirmedCount = [cp, output.completedItems, output.nextActions, dec].filter(
    (field) => field.status === 'confirmed',
  ).length

  return { ok: true, progress: output, confirmedCount }
}
