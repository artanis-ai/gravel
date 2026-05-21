import { describe, it, expect } from 'vitest'
import {
  alignWhitespace,
  computeDiffStats,
  decodeHtmlEntities,
  preserveTrailingNewline,
  undoConservativeEscapes,
} from './SuggestionEditor'

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

describe('undoConservativeEscapes (PR #247 + Olly 2026-05-20)', () => {
  // tiptap-markdown's default serialiser is conservative and escapes
  // structural chars to defend against CommonMark mis-parses. Prompts
  // never go through a markdown renderer, so we strip these to keep
  // the diff clean on round-trip. v0.9.0 went nuclear — strips all
  // backslash-escapes except `\\` (literal backslash, preserved).
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
  it('strips backslash before square brackets (Olly v0.9.0 case)', () => {
    expect(undoConservativeEscapes('see \\[user.name\\] for details')).toBe(
      'see [user.name] for details',
    )
  })
  it('strips backslash before round + curly brackets', () => {
    expect(undoConservativeEscapes('call f\\(x\\) → return \\{result\\}')).toBe(
      'call f(x) → return {result}',
    )
  })
  it('strips backslash before angle brackets (`\\<input\\>`)', () => {
    expect(undoConservativeEscapes('insert \\<input\\> here')).toBe('insert <input> here')
  })
  it('strips backslash before exclamation + period + comma + colon + semicolon', () => {
    expect(undoConservativeEscapes('hi\\! \\,\\. \\:\\;')).toBe('hi! ,. :;')
  })
  it('strips backslash before backtick', () => {
    expect(undoConservativeEscapes('\\`literal backticks\\`')).toBe('`literal backticks`')
  })
  it('strips backslash before newlines (CommonMark hard-break syntax)', () => {
    expect(undoConservativeEscapes('line one\\\nline two\\\nline three')).toBe(
      'line one\nline two\nline three',
    )
  })
  it('preserves literal backslash followed by alpha (no escape was emitted)', () => {
    // \n in source survives because `n` isn't escapable punctuation.
    expect(undoConservativeEscapes('path\\to\\file')).toBe('path\\to\\file')
  })
  it('PRESERVES `\\\\` as literal backslash (Olly\'s `\\\\n` case)', () => {
    // Source has TWO backslashes followed by `n` — the literal
    // 3-char sequence "\\n" (escaped backslash + n char). Must NOT
    // collapse to `\n`. Round-trip parity with the source.
    expect(undoConservativeEscapes('\\\\n')).toBe('\\\\n')
    expect(undoConservativeEscapes('a\\\\b')).toBe('a\\\\b')
  })
  it('handles a mix: literal `\\\\` adjacent to escaped punctuation', () => {
    // `path \\ to \[file\]` — the `\\` stays as `\\`, the `\[` and
    // `\]` get stripped.
    expect(undoConservativeEscapes('path \\\\ to \\[file\\]')).toBe('path \\\\ to [file]')
  })
  it('idempotent over already-clean text', () => {
    const clean = 'Standard prompt content with no escapes.'
    expect(undoConservativeEscapes(clean)).toBe(clean)
  })
})

describe('decodeHtmlEntities (Olly 2026-05-20)', () => {
  // tiptap-markdown's serialiser HTML-encodes `&`, `<`, `>`, `"`,
  // `'` on round-trip. Prompts aren't HTML, so the entity form is
  // hostile — we decode them back to the literal characters.
  it('decodes &amp; → &', () => {
    expect(decodeHtmlEntities('&amp;')).toBe('&')
  })
  it('decodes &lt; / &gt;', () => {
    expect(decodeHtmlEntities('&lt;input&gt;')).toBe('<input>')
  })
  it('decodes &quot; / &apos;', () => {
    expect(decodeHtmlEntities('&quot;hi&quot; &apos;there&apos;')).toBe('"hi" \'there\'')
  })
  it('decodes numeric decimal entities (&#39; → \')', () => {
    expect(decodeHtmlEntities('it&#39;s')).toBe("it's")
  })
  it('decodes numeric hex entities (&#x27; → \')', () => {
    expect(decodeHtmlEntities('it&#x27;s')).toBe("it's")
  })
  it('decodes &amp; LAST so &amp;amp; only unwinds one level', () => {
    // Source had the literal 5-char sequence "&amp;" (e.g. a prompt
    // teaching about HTML escaping). tiptap-markdown re-encodes it as
    // "&amp;amp;" — we must unwind ONE level so the round-trip
    // matches the user's literal source.
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;')
  })
  it('idempotent over already-clean text', () => {
    const clean = 'Standard prompt content without entities.'
    expect(decodeHtmlEntities(clean)).toBe(clean)
  })
  it('passes through unknown entities unchanged (no over-decode)', () => {
    // `&nbsp;` isn't on our decode list — leave it alone rather than
    // crash or corrupt.
    expect(decodeHtmlEntities('&nbsp;hello&nbsp;')).toBe('&nbsp;hello&nbsp;')
  })
})

describe('preserveTrailingNewline (Olly 2026-05-20)', () => {
  // POSIX text files end with `\n`. CommonMark serialisers drop it.
  // Without this, every load of a POSIX-conformant prompt injects a
  // phantom -1 diff. v0.9.0 fix.
  it('restores trailing newline when original had one and candidate doesn\'t', () => {
    expect(preserveTrailingNewline('hello\n', 'hello')).toBe('hello\n')
  })
  it('strips trailing newlines the serialiser added but the source didn\'t have', () => {
    expect(preserveTrailingNewline('hello', 'hello\n')).toBe('hello')
    expect(preserveTrailingNewline('hello', 'hello\n\n')).toBe('hello')
  })
  it('passes through when both ends agree', () => {
    expect(preserveTrailingNewline('hello\n', 'hello\n')).toBe('hello\n')
    expect(preserveTrailingNewline('hello', 'hello')).toBe('hello')
  })
  it('handles multi-line content', () => {
    expect(preserveTrailingNewline('line 1\nline 2\n', 'line 1\nline 2')).toBe(
      'line 1\nline 2\n',
    )
  })
  it('handles empty strings safely', () => {
    expect(preserveTrailingNewline('', '')).toBe('')
    expect(preserveTrailingNewline('\n', '')).toBe('\n')
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

  // Line-aware alignment (v0.10.3): when the user edits ONE line, the
  // OTHER lines must keep the source-file's whitespace. The token-level
  // fast path falls through (one token changed), but per-line matching
  // still restores tabs / leading whitespace on unedited lines.
  // Yousef's de-platform dogfooding 2026-05-21 surfaced this — tab-
  // indented bullets in the source file came back as 2-space indents
  // after a single-line edit anywhere in the document.

  it('line-aware: tab-indented bullets keep their tabs when an UNRELATED line is edited', () => {
    const orig =
      'edits: A list of PER-LINE edits. Each element has:\n' +
      '\n' +
      '\t- line: the 1-indexed line number being edited\n' +
      '\t- ops: a list of fine-grained operations\n' +
      '\n' +
      'Each op is one of:\n' +
      '\n' +
      '\t- {{type: "replace", "find": "<x>", "replacement": "<y>"}}\n' +
      '\t- {{type: "delete", "find": "<x>"}}\n'
    // Candidate: serializer normalised tabs → 2-space indents AND the
    // user edited one bullet (final "delete" → "remove"). Per-line
    // alignment must restore tabs on every line whose trimmed content
    // matches the source.
    const candidate =
      'edits: A list of PER-LINE edits. Each element has:\n' +
      '\n' +
      '  - line: the 1-indexed line number being edited\n' +
      '  - ops: a list of fine-grained operations\n' +
      '\n' +
      'Each op is one of:\n' +
      '\n' +
      '  - {{type: "replace", "find": "<x>", "replacement": "<y>"}}\n' +
      '  - {{type: "remove", "find": "<x>"}}\n'
    const result = alignWhitespace(orig, candidate)
    // Unedited tab-indented bullets must keep their tabs.
    expect(result).toContain('\t- line: the 1-indexed line number being edited')
    expect(result).toContain('\t- ops: a list of fine-grained operations')
    expect(result).toContain('\t- {{type: "replace"')
    // Edited line keeps its NEW content (with whatever whitespace).
    expect(result).toContain('"remove"')
    // No phantom 2-space-indented unedited lines.
    expect(result).not.toContain('  - line: the 1-indexed line number being edited')
    expect(result).not.toContain('  - ops: a list of fine-grained')
  })

  it('line-aware: per-line whitespace alignment falls through gracefully when no match found', () => {
    // Lines that don't appear in source (entirely new) keep candidate whitespace.
    const orig = 'Line A\nLine B\n'
    const candidate = 'Line A\nLine B\n  Line C inserted indented\n'
    const result = alignWhitespace(orig, candidate)
    // Original lines preserved as-is from source; new line keeps candidate ws.
    expect(result).toContain('Line A\n')
    expect(result).toContain('Line B\n')
    expect(result).toContain('  Line C inserted indented')
  })

  it('line-aware: ambiguous matches (duplicate trimmed content) pick the nearest by position', () => {
    // Two identical empty lines in source, both at different positions;
    // candidate has them too. Each candidate empty line should map to
    // the source empty line at the closest index.
    const orig = 'header\n\nmiddle\n\nfooter\n'
    const candidate = 'header\n  \nmiddle\n  \nfooter' // serialiser added trailing spaces
    const result = alignWhitespace(orig, candidate)
    // Source's bare-newline empty lines should win for both empties.
    expect(result).not.toContain('  \n') // no trailing-spaces lines leaked through
  })

  it('line-aware: leading whitespace inside a paragraph (code block start) preserved', () => {
    // Indented code spans (CommonMark §4.4): 4+ spaces. Source uses tab.
    // After roundtrip, candidate has 4 spaces. Source must win on the
    // unedited code line; edited line elsewhere doesn't affect it.
    const orig = 'Example:\n\n\tprint("hello")\n\nDone.\n'
    const candidate = 'Examples:\n\n    print("hello")\n\nDone.\n' // "Example" → "Examples"
    const result = alignWhitespace(orig, candidate)
    // Edited heading-like line keeps its candidate content.
    expect(result).toContain('Examples:')
    // Unedited code line keeps source's tab indent.
    expect(result).toContain('\tprint("hello")')
    expect(result).not.toContain('    print("hello")')
  })
})
