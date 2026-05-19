import { describe, it, expect } from 'vitest'
import { alignWhitespace, computeDiffStats, undoConservativeEscapes } from './SuggestionEditor'

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
  it('strips backslash before newlines (CommonMark hard-break syntax)', () => {
    // breaks:true + tiptap-markdown emits `\<newline>` for each hard
    // break. Source had plain `\n`. Without this strip, every newline
    // in a prompt adds a phantom +1/-0 to the diff.
    expect(undoConservativeEscapes('line one\\\nline two\\\nline three')).toBe(
      'line one\nline two\nline three',
    )
  })
  it('preserves literal backslash sequences', () => {
    // `\\` (escaped backslash) shouldn't get over-collapsed. Real
    // path strings like `path\\to\\file` survive intact.
    expect(undoConservativeEscapes('path\\to\\file')).toBe('path\\to\\file')
  })
})

describe('alignWhitespace (paragraph-vs-list separator drift)', () => {
  it('returns the original when content is identical modulo whitespace', () => {
    const orig = 'text:\n- one\n- two'
    const candidate = 'text:\n\n- one\n- two' // serialiser inserted blank line
    expect(alignWhitespace(orig, candidate)).toBe(orig)
  })
  it('passes through candidate when content tokens differ', () => {
    const orig = 'text: one two'
    const candidate = 'text: one three'
    expect(alignWhitespace(orig, candidate)).toBe(candidate)
  })
  it('passes through when token count differs (added paragraph)', () => {
    const orig = 'one\n\ntwo'
    const candidate = 'one\n\ntwo\n\nthree'
    expect(alignWhitespace(orig, candidate)).toBe(candidate)
  })
  it('handles trailing newline lost on serialise (CommonMark convention)', () => {
    // prosemirror-markdown drops the source's trailing newline. Same
    // non-ws tokens; alignWhitespace must restore the trailing `\n`.
    const orig = 'one\ntwo\n'
    const candidate = 'one\n\ntwo'
    expect(alignWhitespace(orig, candidate)).toBe(orig)
  })
  it('investigator-shape: paragraph→list separator AND trailing newline drift', () => {
    // Landlord-ai investigator.md class: paragraph followed by bullet
    // list (serialiser inserts `\n\n`) PLUS source's trailing newline
    // gets stripped. Two whitespace drifts at once; algorithm must
    // still recognise the non-ws sequence is identical.
    const orig = 'questions like:\n- "first?"\n- "second?"\n'
    const candidate = 'questions like:\n\n- "first?"\n- "second?"'
    expect(alignWhitespace(orig, candidate)).toBe(orig)
  })
  it('identity on already-equal inputs', () => {
    const s = 'identical text'
    expect(alignWhitespace(s, s)).toBe(s)
  })
  it('handles empty strings safely', () => {
    expect(alignWhitespace('', '')).toBe('')
    expect(alignWhitespace('content', '')).toBe('')
    expect(alignWhitespace('', 'content')).toBe('content')
  })
})
