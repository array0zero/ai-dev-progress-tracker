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
    for (const item of dec.items) {
      if (
        item.decision.trim() === '' ||
        item.rationale.trim() === '' ||
        item.evidenceIds.length === 0
      ) {
        return invalid('importantDecisions item form is invalid')
      }
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
