import { describe, expect, it } from 'vitest'
import { validateProgressOutput } from '../../src/server/schemas/progress.js'

const EVIDENCE = new Set(['ev-1', 'ev-2', 'ev-3'])

function validOutput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    currentPosition: { status: 'confirmed', text: '基盤実装フェーズ', evidenceIds: ['ev-1'] },
    completedItems: {
      status: 'confirmed',
      items: [{ text: 'DBスキーマ作成', evidenceIds: ['ev-1'] }],
      evidenceIds: ['ev-1'],
    },
    nextActions: {
      status: 'confirmed',
      items: [{ text: 'Codex連携', evidenceIds: ['ev-2'] }],
      evidenceIds: ['ev-2'],
    },
    importantDecisions: {
      status: 'confirmed',
      items: [
        { decision: 'SQLiteを採用', rationale: '単一ユーザーローカルMVP', evidenceIds: ['ev-3'] },
      ],
      evidenceIds: ['ev-3'],
    },
  }
}

const needsInputText = { status: 'needs_input', text: '要補完', evidenceIds: [] }
const needsInputList = { status: 'needs_input', items: [], evidenceIds: [] }

describe('validateProgressOutput', () => {
  it('accepts a valid 4/4 confirmed output', () => {
    const result = validateProgressOutput(validOutput(), EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.confirmedCount).toBe(4)
    }
  })

  it('rejects output missing a required field', () => {
    const output = validOutput()
    output.nextActions = undefined
    expect(validateProgressOutput(output, EVIDENCE).ok).toBe(false)
  })

  it('rejects output referencing an evidence id not in run_evidence', () => {
    const output = validOutput()
    output.currentPosition = { status: 'confirmed', text: 'x', evidenceIds: ['ev-unknown'] }
    const result = validateProgressOutput(output, EVIDENCE)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('UNKNOWN_EVIDENCE_ID')
    }
  })

  it('canonicalizes a needs_input text field that carries stray text or evidence', () => {
    const output = validOutput()
    output.currentPosition = {
      status: 'needs_input',
      text: '現在位置を示す根拠がありません',
      evidenceIds: ['ev-1'],
    }
    const result = validateProgressOutput(output, EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.progress.currentPosition).toEqual({
        status: 'needs_input',
        text: '要補完',
        evidenceIds: [],
      })
      expect(result.confirmedCount).toBe(3)
    }
  })

  it('canonicalizes a needs_input list/decision field that still carries items or evidence', () => {
    const output = validOutput()
    output.completedItems = {
      status: 'needs_input',
      items: [{ text: 'x', evidenceIds: [] }],
      evidenceIds: ['ev-1'],
    }
    output.importantDecisions = {
      status: 'needs_input',
      items: [{ decision: 'd', rationale: 'r', evidenceIds: ['ev-3'] }],
      evidenceIds: ['ev-3'],
    }
    const result = validateProgressOutput(output, EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.progress.completedItems).toEqual({
        status: 'needs_input',
        items: [],
        evidenceIds: [],
      })
      expect(result.progress.importantDecisions).toEqual({
        status: 'needs_input',
        items: [],
        evidenceIds: [],
      })
      expect(result.confirmedCount).toBe(2)
    }
  })

  it('allows importantDecisions confirmed with items=[] when field-level evidence is present', () => {
    const output = validOutput()
    output.importantDecisions = { status: 'confirmed', items: [], evidenceIds: ['ev-3'] }
    expect(validateProgressOutput(output, EVIDENCE).ok).toBe(true)
  })

  it('rejects importantDecisions confirmed with items=[] and no field-level evidence', () => {
    const output = validOutput()
    output.importantDecisions = { status: 'confirmed', items: [], evidenceIds: [] }
    expect(validateProgressOutput(output, EVIDENCE).ok).toBe(false)
  })

  it('drops malformed importantDecisions items but keeps the field when evidence is present', () => {
    const output = validOutput()
    output.importantDecisions = {
      status: 'confirmed',
      items: [
        { decision: 'SQLiteを採用', rationale: '単一ユーザーMVP', evidenceIds: ['ev-3'] },
        { decision: '', rationale: '', evidenceIds: [] },
        { decision: 'd', rationale: 'r', evidenceIds: [] },
      ],
      evidenceIds: ['ev-3'],
    }
    const result = validateProgressOutput(output, EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.progress.importantDecisions.items).toEqual([
        { decision: 'SQLiteを採用', rationale: '単一ユーザーMVP', evidenceIds: ['ev-3'] },
      ])
      expect(result.confirmedCount).toBe(4)
    }
  })

  it('rejects a confirmed list field with an empty items array', () => {
    const output = validOutput()
    output.completedItems = { status: 'confirmed', items: [], evidenceIds: ['ev-1'] }
    expect(validateProgressOutput(output, EVIDENCE).ok).toBe(false)
  })

  it('rejects a confirmed item that has no evidence', () => {
    const output = validOutput()
    output.completedItems = {
      status: 'confirmed',
      items: [{ text: 'x', evidenceIds: [] }],
      evidenceIds: ['ev-1'],
    }
    expect(validateProgressOutput(output, EVIDENCE).ok).toBe(false)
  })

  it('counts confirmed fields for a 3 confirmed + 1 needs_input output', () => {
    const output = { ...validOutput(), importantDecisions: needsInputList }
    const result = validateProgressOutput(output, EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.confirmedCount).toBe(3)
    }
  })

  it('accepts an all needs_input output with confirmedCount 0', () => {
    const output = {
      schemaVersion: 1,
      currentPosition: needsInputText,
      completedItems: needsInputList,
      nextActions: needsInputList,
      importantDecisions: needsInputList,
    }
    const result = validateProgressOutput(output, EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.confirmedCount).toBe(0)
    }
  })
})
