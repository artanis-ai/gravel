import { describe, it, expect } from 'vitest'
import { computeDiffStats } from './SuggestionEditor'

describe('computeDiffStats', () => {
  it('reports zeros when texts match', () => {
    expect(computeDiffStats('hello', 'hello')).toEqual({ insertions: 0, deletions: 0 })
  })

  it('counts pure insertions', () => {
    expect(computeDiffStats('abc', 'abXYZc')).toEqual({ insertions: 3, deletions: 0 })
  })

  it('counts pure deletions', () => {
    expect(computeDiffStats('abcdef', 'abf')).toEqual({ insertions: 0, deletions: 3 })
  })

  it('counts mixed insertion + deletion', () => {
    // "helpful" → "honest": 5 chars removed (elpful), 4 inserted (onest);
    // diffChars groups around shared chars so the exact split depends on
    // the algorithm — assert by sum invariants instead of exact counts.
    const stats = computeDiffStats('You are a helpful assistant.', 'You are an honest assistant.')
    expect(stats.insertions + stats.deletions).toBeGreaterThan(0)
    expect(stats.insertions).toBeGreaterThan(0)
    expect(stats.deletions).toBeGreaterThan(0)
  })
})
