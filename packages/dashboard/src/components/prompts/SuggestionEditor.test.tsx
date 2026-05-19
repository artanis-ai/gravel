import { describe, it, expect } from 'vitest'
import { computeDiffStats, undoConservativeEscapes } from './SuggestionEditor'

describe('computeDiffStats (word-level)', () => {
  it('reports zeros when texts match', () => {
    expect(computeDiffStats('hello world', 'hello world')).toEqual({
      insertions: 0,
      deletions: 0,
    })
  })

  it('counts a pure word insertion', () => {
    // 'careful ' (8 chars including trailing space) was inserted.
    const s = computeDiffStats(
      'You are a helpful assistant.',
      'You are a careful helpful assistant.',
    )
    expect(s.insertions).toBe(8)
    expect(s.deletions).toBe(0)
  })

  it('counts a pure word deletion', () => {
    // 'helpful ' was deleted.
    const s = computeDiffStats(
      'You are a helpful assistant.',
      'You are a assistant.',
    )
    expect(s.deletions).toBe(8)
    expect(s.insertions).toBe(0)
  })

  it('counts a word swap as insert + delete', () => {
    // 'helpful' (7) → 'honest' (6) — both as whole-word swaps.
    const s = computeDiffStats(
      'You are a helpful assistant.',
      'You are a honest assistant.',
    )
    expect(s.insertions).toBe(6)
    expect(s.deletions).toBe(7)
  })

  it('treats whitespace as a unit so newlines don\'t inflate counts', () => {
    // Adding a paragraph break — diffWordsWithSpace emits the new
    // newline as its own chunk; we count it as a 1-char insertion.
    const s = computeDiffStats('a b', 'a\nb')
    expect(s.insertions).toBe(1)
    expect(s.deletions).toBe(1)
  })
})

describe('undoConservativeEscapes (PR #247 round-trip)', () => {
  // tiptap-markdown's default serialiser is conservative and escapes
  // structural chars to defend against CommonMark mis-parses. Prompts
  // never go through a markdown renderer, so we strip these to keep
  // the diff clean on round-trip.
  it('strips backslash before dashes (---ORIGINAL OUTPUT--- case)', () => {
    expect(undoConservativeEscapes('\\--- ORIGINAL OUTPUT \\---')).toBe('--- ORIGINAL OUTPUT ---')
  })
  it('strips backslash before underscores', () => {
    expect(undoConservativeEscapes('snake\\_case')).toBe('snake_case')
  })
  it('strips backslash before asterisks', () => {
    expect(undoConservativeEscapes('not \\*bold\\*')).toBe('not *bold*')
  })
  it('strips backslash before hashes (template-var sigils stay literal)', () => {
    expect(undoConservativeEscapes('\\#tag')).toBe('#tag')
  })
  it('leaves non-escape backslashes alone', () => {
    expect(undoConservativeEscapes('path\\to\\file')).toBe('path\\to\\file')
  })
  it('idempotent over already-clean text', () => {
    const clean = 'Standard prompt content with no escapes.'
    expect(undoConservativeEscapes(clean)).toBe(clean)
  })
})
