/**
 * Behavioural round-trip tests for the SuggestionEditor.
 *
 * The unit tests in SuggestionEditor.test.tsx pin helpers in isolation
 * (computeDiffStats, undoConservativeEscapes). They don't catch bugs
 * where the helpers are individually correct but the *integration*
 * (Tiptap parse → ProseMirror doc → tiptap-markdown serialize →
 * post-process) still drifts. Yousef's landlord-ai dogfooding caught
 * exactly that class: every fixture-style prompt opened in the editor
 * showed a phantom `+N -0` diff before any edit, because tiptap-
 * markdown emits hard breaks as `\<newline>` and our helper only
 * stripped the structural-char escapes.
 *
 * This file mounts the real SuggestionEditor against representative
 * prompt shapes and asserts that the diff stats stay at 0/0 with no
 * user input. New shapes go here as we discover them in the wild.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { SuggestionEditor } from './SuggestionEditor'

/**
 * Mount the editor with `original` as both the server truth and the
 * draft text, wait until tiptap settles, then read the most recent
 * onDiffStats callback. Returns 0/0 for a stable round-trip.
 */
async function mountAndGetStats(original: string): Promise<{ insertions: number; deletions: number }> {
  const onDiffStats = vi.fn()
  const onChange = vi.fn()
  await act(async () => {
    render(
      <SuggestionEditor
        original={original}
        value={original}
        onChange={onChange}
        onDiffStats={onDiffStats}
      />,
    )
    // Let tiptap finish mounting + the initial onUpdate fire.
    await new Promise((r) => setTimeout(r, 50))
  })
  await waitFor(() => {
    if (onDiffStats.mock.calls.length === 0) {
      throw new Error('onDiffStats never fired')
    }
  })
  return onDiffStats.mock.calls[onDiffStats.mock.calls.length - 1][0]
}

describe('SuggestionEditor round-trip stability (no spurious diff)', () => {
  it('single-line prompt: zero diff on mount', async () => {
    const stats = await mountAndGetStats('You are a careful assistant.')
    expect(stats).toEqual({ insertions: 0, deletions: 0 })
  })

  it('multi-line prompt with single newlines: zero diff (PR #247 + landlord-ai class)', async () => {
    // Three lines joined by single `\n`. tiptap-markdown with breaks:true
    // parses each newline as a hard break and serialises as `\<newline>`.
    // undoConservativeEscapes strips the backslash; the result must
    // be byte-identical to the source.
    const src =
      'Decide if the tenant\'s message is a greeting with no actual question\n' +
      '(e.g. "hi", "hey there", "good morning"). If yes, reply with the literal\n' +
      'string GREETING. Otherwise reply with QUESTION. No other output.'
    const stats = await mountAndGetStats(src)
    expect(stats).toEqual({ insertions: 0, deletions: 0 })
  })

  it('dash-delimited section headers: zero diff (PR #247 canonical case)', async () => {
    // Default markdown-it serialiser escapes leading dashes as `\---`
    // because three dashes look like a horizontal rule. Prompts ship
    // this pattern routinely as section delimiters.
    const src =
      'Below is the input.\n' +
      '--- ORIGINAL OUTPUT ---\n' +
      '{original_output}\n' +
      '--- NEW OUTPUT ---\n' +
      '{new_output}'
    const stats = await mountAndGetStats(src)
    expect(stats).toEqual({ insertions: 0, deletions: 0 })
  })

  it('prompt with paragraph breaks (double newlines): zero diff', async () => {
    const src =
      'You are an evaluation judge.\n\n' +
      'You will be given:\n\n' +
      '1. The original output\n' +
      '2. The feedback\n\n' +
      'Return "pass" or "fail".'
    const stats = await mountAndGetStats(src)
    expect(stats).toEqual({ insertions: 0, deletions: 0 })
  })

  it('paragraph followed by bullet list (single newline separator): zero diff', async () => {
    // CommonMark serialiser puts `\n\n` between a paragraph and a
    // following list. Landlord-ai investigator prompt has the source
    // form `text:\n- item` (single newline). Round-trip must restore
    // the original separator.
    const src =
      'Examples of clarifying questions you might ask are like:\n' +
      '- "Can you describe the smell?"\n' +
      '- "Where exactly is the leak?"\n' +
      '- "How long has this been happening?"'
    const stats = await mountAndGetStats(src)
    expect(stats).toEqual({ insertions: 0, deletions: 0 })
  })

  it('curly-quote-free prompt: tiptap doesn\'t smart-quote the literal "', async () => {
    // The editor must NOT replace ASCII " with curly “” on parse,
    // otherwise prompts with code-style quoted strings drift.
    const src = 'Reply with the literal string "GREETING" or "QUESTION".'
    const stats = await mountAndGetStats(src)
    expect(stats).toEqual({ insertions: 0, deletions: 0 })
  })
})
