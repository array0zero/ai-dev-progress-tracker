import { describe, expect, it } from 'vitest'
import {
  classifyByConfirmedCount,
  missingFieldKeys,
  validateProgressOutput,
} from '../../src/server/schemas/progress.js'

const EVIDENCE = new Set(['ev-a'])

function field(needsInput: boolean, kind: 'text' | 'list' | 'decision'): Record<string, unknown> {
  if (needsInput) {
    return kind === 'text'
      ? { status: 'needs_input', text: '要補完', evidenceIds: [] }
      : { status: 'needs_input', items: [], evidenceIds: [] }
  }
  if (kind === 'text') {
    return { status: 'confirmed', text: '現在地', evidenceIds: ['ev-a'] }
  }
  if (kind === 'list') {
    return {
      status: 'confirmed',
      items: [{ text: 'x', evidenceIds: ['ev-a'] }],
      evidenceIds: ['ev-a'],
    }
  }
  return {
    status: 'confirmed',
    items: [{ decision: 'd', rationale: 'r', evidenceIds: ['ev-a'] }],
    evidenceIds: ['ev-a'],
  }
}

function output(needsInput: {
  currentPosition?: boolean
  completedItems?: boolean
  nextActions?: boolean
  importantDecisions?: boolean
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    currentPosition: field(needsInput.currentPosition ?? false, 'text'),
    completedItems: field(needsInput.completedItems ?? false, 'list'),
    nextActions: field(needsInput.nextActions ?? false, 'list'),
    importantDecisions: field(needsInput.importantDecisions ?? false, 'decision'),
  }
}

describe('classifyByConfirmedCount', () => {
  it('maps 4 confirmed fields to complete / succeeded', () => {
    expect(classifyByConfirmedCount(4)).toEqual({
      runStatus: 'succeeded',
      recoveryStatus: 'complete',
    })
  })

  it('maps 1..3 confirmed fields to partial', () => {
    for (const count of [1, 2, 3]) {
      expect(classifyByConfirmedCount(count)).toEqual({
        runStatus: 'partial',
        recoveryStatus: 'partial',
      })
    }
  })

  it('maps 0 confirmed fields to unrecoverable', () => {
    expect(classifyByConfirmedCount(0)).toEqual({
      runStatus: 'unrecoverable',
      recoveryStatus: 'unrecoverable',
    })
  })
})

describe('recovery classification through validateProgressOutput', () => {
  it('a 4/4 fixture is complete with no missing fields', () => {
    const result = validateProgressOutput(output({}), EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(classifyByConfirmedCount(result.confirmedCount).recoveryStatus).toBe('complete')
      expect(
        missingFieldKeys({
          currentPosition: result.progress.currentPosition.status,
          completedItems: result.progress.completedItems.status,
          nextActions: result.progress.nextActions.status,
          importantDecisions: result.progress.importantDecisions.status,
        }),
      ).toEqual([])
    }
  })

  it('one field lacking evidence is needs_input, the whole result is partial', () => {
    const result = validateProgressOutput(output({ nextActions: true }), EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(classifyByConfirmedCount(result.confirmedCount).recoveryStatus).toBe('partial')
      expect(result.progress.nextActions.status).toBe('needs_input')
      expect(
        missingFieldKeys({
          currentPosition: result.progress.currentPosition.status,
          completedItems: result.progress.completedItems.status,
          nextActions: result.progress.nextActions.status,
          importantDecisions: result.progress.importantDecisions.status,
        }),
      ).toEqual(['nextActions'])
    }
  })

  it('all fields lacking evidence is unrecoverable', () => {
    const result = validateProgressOutput(
      output({
        currentPosition: true,
        completedItems: true,
        nextActions: true,
        importantDecisions: true,
      }),
      EVIDENCE,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(classifyByConfirmedCount(result.confirmedCount).recoveryStatus).toBe('unrecoverable')
    }
  })

  it('strips a concrete value from a needs_input field rather than storing it', () => {
    const messy = output({})
    messy.currentPosition = { status: 'needs_input', text: '確定値', evidenceIds: [] }
    const result = validateProgressOutput(messy, EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.progress.currentPosition).toEqual({
        status: 'needs_input',
        text: '要補完',
        evidenceIds: [],
      })
    }
  })
})

describe('v1.7 classification is not weakened by tolerated output noise', () => {
  it('keeps a 4/4 complete result when one malformed decision item is dropped', () => {
    const messy = output({})
    messy.importantDecisions = {
      status: 'confirmed',
      items: [
        { decision: 'd', rationale: 'r', evidenceIds: ['ev-a'] },
        { decision: '', rationale: '', evidenceIds: [] },
      ],
      evidenceIds: ['ev-a'],
    }
    const result = validateProgressOutput(messy, EVIDENCE)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.progress.importantDecisions.items).toHaveLength(1)
      expect(classifyByConfirmedCount(result.confirmedCount).recoveryStatus).toBe('complete')
    }
  })

  it('classifies 3 confirmed as partial and 4 as complete at the boundary', () => {
    const partial = validateProgressOutput(output({ importantDecisions: true }), EVIDENCE)
    const complete = validateProgressOutput(output({}), EVIDENCE)
    expect(partial.ok && classifyByConfirmedCount(partial.confirmedCount)).toEqual({
      runStatus: 'partial',
      recoveryStatus: 'partial',
    })
    expect(complete.ok && classifyByConfirmedCount(complete.confirmedCount)).toEqual({
      runStatus: 'succeeded',
      recoveryStatus: 'complete',
    })
  })
})
