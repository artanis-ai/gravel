/**
 * tryParseStructuredString: must handle real-world payload shapes
 * from LangChain Python (str(dict)) AND OpenAI (JSON arguments).
 */
import { describe, expect, it } from 'vitest'

import { tryParseStructuredString } from './parseStructured'

describe('tryParseStructuredString', () => {
  it('passes non-strings through unchanged', () => {
    expect(tryParseStructuredString(42)).toBe(42)
    expect(tryParseStructuredString(null)).toBe(null)
    expect(tryParseStructuredString({ a: 1 })).toEqual({ a: 1 })
  })

  it('parses valid JSON objects', () => {
    expect(tryParseStructuredString('{"a": 1, "b": "two"}')).toEqual({ a: 1, b: 'two' })
  })

  it('parses valid JSON arrays', () => {
    expect(tryParseStructuredString('[1, "two", null]')).toEqual([1, 'two', null])
  })

  it('rewrites a Python repr with single quotes + False', () => {
    const py = "{'contractor_name': 'Reliable Plumbing', 'issue_description': '1. **Subject** — Area behind toilet and pedestal sink.', 'is_emergency': False}"
    expect(tryParseStructuredString(py)).toEqual({
      contractor_name: 'Reliable Plumbing',
      issue_description: '1. **Subject** — Area behind toilet and pedestal sink.',
      is_emergency: false,
    })
  })

  it('rewrites Python True / None as well', () => {
    const py = "{'a': True, 'b': None, 'c': 1, 'd': 1.5}"
    expect(tryParseStructuredString(py)).toEqual({ a: true, b: null, c: 1, d: 1.5 })
  })

  it('preserves the True / False / None tokens INSIDE strings', () => {
    const py = "{'note': 'the answer is True'}"
    expect(tryParseStructuredString(py)).toEqual({ note: 'the answer is True' })
  })

  it("handles a Python value that contains an apostrophe (Python switches outer to double quotes)", () => {
    const py = `{'msg': "don't panic"}`
    expect(tryParseStructuredString(py)).toEqual({ msg: "don't panic" })
  })

  it("handles a Python value with a backslash-escaped apostrophe", () => {
    // Some Python tools escape rather than switching the outer quote.
    const py = "{'msg': 'don\\'t panic'}"
    expect(tryParseStructuredString(py)).toEqual({ msg: "don't panic" })
  })

  it('returns the original string when the string does not start with { or [', () => {
    expect(tryParseStructuredString('hello world')).toBe('hello world')
  })

  it('returns the original string when the value is unterminated garbage', () => {
    const broken = "{'a': 'unterminated"
    // Either bail back to the raw string or return null; we expect raw.
    expect(tryParseStructuredString(broken)).toBe(broken)
  })

  it('does not rewrite True when adjacent to identifier chars (e.g. inside camelCase)', () => {
    const py = "{'TrueValue': 1}"
    // The literal token boundary check should prevent rewriting.
    expect(tryParseStructuredString(py)).toEqual({ TrueValue: 1 })
  })
})
