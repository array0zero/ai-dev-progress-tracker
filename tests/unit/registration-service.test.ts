import { describe, expect, it } from 'vitest'
import {
  buildSummary,
  normalizeRepositoryName,
} from '../../src/server/services/registration-service.js'

const CANDIDATE_ID = '3f2b9c1d-4e5a-6789-abcd-ef0123456789'

describe('normalizeRepositoryName', () => {
  it('lowercases ASCII and collapses whitespace into a single dash', () => {
    expect(normalizeRepositoryName('My  Cool   App', CANDIDATE_ID)).toBe('my-cool-app')
  })

  it('applies NFKC before normalizing', () => {
    expect(normalizeRepositoryName('Ｍｙ　Ａｐｐ', CANDIDATE_ID)).toBe('my-app')
  })

  it('replaces unsupported characters and collapses repeats', () => {
    expect(normalizeRepositoryName('ai/dev:progress**tracker', CANDIDATE_ID)).toBe(
      'ai-dev-progress-tracker',
    )
  })

  it('keeps dots, dashes and underscores', () => {
    expect(normalizeRepositoryName('my_app.v2-beta', CANDIDATE_ID)).toBe('my_app.v2-beta')
  })

  it('trims leading and trailing dots and dashes', () => {
    expect(normalizeRepositoryName('--.my-app.--', CANDIDATE_ID)).toBe('my-app')
  })

  it('truncates to 100 characters and trims again', () => {
    const name = normalizeRepositoryName(`${'a'.repeat(99)}-${'b'.repeat(20)}`, CANDIDATE_ID)
    expect(name).toHaveLength(99)
    expect(name.endsWith('-')).toBe(false)
  })

  it('falls back to project-<8 hex> when nothing usable remains', () => {
    expect(normalizeRepositoryName('日本語のみ', CANDIDATE_ID)).toBe('project-3f2b9c1d')
    expect(normalizeRepositoryName('   ', CANDIDATE_ID)).toBe('project-3f2b9c1d')
  })
})

describe('buildSummary', () => {
  it('prefers the GitHub description', () => {
    expect(buildSummary('  A private tracker  ', '# Title\n\nreadme body', 'name')).toBe(
      'A private tracker',
    )
  })

  it('falls back to the first non-heading README paragraph', () => {
    const readme = '# Title\n\n## Subtitle\n\nこのプロジェクトは\n進捗を追跡します。\n\nsecond'
    expect(buildSummary('', readme, 'name')).toBe('このプロジェクトは 進捗を追跡します。')
  })

  it('falls back to the project name when there is no description or README text', () => {
    expect(buildSummary('', null, 'my project')).toBe('my project')
    expect(buildSummary('   ', '# Only a heading\n', 'my project')).toBe('my project')
  })

  it('caps the summary at 240 characters', () => {
    expect(buildSummary('x'.repeat(500), null, 'name')).toHaveLength(240)
    expect(buildSummary('', 'y'.repeat(500), 'name')).toHaveLength(240)
  })
})
