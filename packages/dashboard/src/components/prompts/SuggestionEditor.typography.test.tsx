/**
 * Typography-regression tests for the SuggestionEditor.
 *
 * In v0.9.5 the `.gravel-prose` CSS block was deleted from styles.css
 * while the class was still applied to the editor's contenteditable.
 * Result: headings stopped looking like headings, lists lost bullets,
 * blockquotes lost the left rule. Olly's 2026-05-21 dogfooding caught
 * it. v0.10.0 restored the rules and added this test.
 *
 * Two assertions:
 *  1. The editor's contenteditable applies the `gravel-prose` class —
 *     if it ever loses this class, the inline CSS in styles.css can't
 *     reach it and typography breaks invisibly. (Pinned at the DOM
 *     level; doesn't depend on Tailwind loading.)
 *  2. The source `styles.css` defines visual rules for the headings,
 *     lists, code, blockquote, link selectors under `.gravel-prose`.
 *     This is a build-time check that catches the inverse regression:
 *     class still applied, CSS deleted again.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SuggestionEditor } from './SuggestionEditor'

describe('SuggestionEditor typography (v0.9.5 regression — v0.10.0 fix)', () => {
  it('applies .gravel-prose to the editor surface', async () => {
    const onChange = vi.fn()
    const onDiffStats = vi.fn()
    let result: ReturnType<typeof render>
    await act(async () => {
      result = render(
        <SuggestionEditor
          original={'# Hello\n\nworld'}
          value={'# Hello\n\nworld'}
          onChange={onChange}
          onDiffStats={onDiffStats}
        />,
      )
      await new Promise((r) => setTimeout(r, 50))
    })
    await waitFor(() => {
      const surface = result!.container.querySelector('[data-testid="suggestion-editor-content"]')
      expect(surface).not.toBeNull()
      expect(surface?.classList.contains('gravel-prose')).toBe(true)
    })
  })

  it('renders markdown headings as <h1>/<h2>/<h3> elements (Tiptap transform)', async () => {
    const md = '# Heading 1\n\n## Heading 2\n\n### Heading 3\n\nbody text'
    const onChange = vi.fn()
    const onDiffStats = vi.fn()
    let result: ReturnType<typeof render>
    await act(async () => {
      result = render(
        <SuggestionEditor original={md} value={md} onChange={onChange} onDiffStats={onDiffStats} />,
      )
      await new Promise((r) => setTimeout(r, 50))
    })
    await waitFor(() => {
      const surface = result!.container.querySelector('[data-testid="suggestion-editor-content"]')
      expect(surface?.querySelector('h1')?.textContent).toBe('Heading 1')
      expect(surface?.querySelector('h2')?.textContent).toBe('Heading 2')
      expect(surface?.querySelector('h3')?.textContent).toBe('Heading 3')
    })
  })

  it('renders markdown lists as <ul>/<li> (so the CSS bullet rule has something to style)', async () => {
    const md = '- one\n- two\n- three'
    const onChange = vi.fn()
    const onDiffStats = vi.fn()
    let result: ReturnType<typeof render>
    await act(async () => {
      result = render(
        <SuggestionEditor original={md} value={md} onChange={onChange} onDiffStats={onDiffStats} />,
      )
      await new Promise((r) => setTimeout(r, 50))
    })
    await waitFor(() => {
      const surface = result!.container.querySelector('[data-testid="suggestion-editor-content"]')
      const items = surface?.querySelectorAll('ul li')
      expect(items?.length).toBe(3)
    })
  })
})

describe('styles.css defines visual rules for .gravel-prose (the regression we caught)', () => {
  // Resolve up from the test file: components/prompts → components → src
  const stylesPath = resolve(__dirname, '../../styles.css')
  const css = readFileSync(stylesPath, 'utf-8')

  it('declares the .gravel-prose root selector', () => {
    expect(css).toMatch(/\.gravel-prose\s*\{/)
  })

  it.each([
    ['headings', /\.gravel-prose\s+h1\s*\{/],
    ['h2', /\.gravel-prose\s+h2\s*\{/],
    ['h3', /\.gravel-prose\s+h3\s*\{/],
    ['unordered lists', /\.gravel-prose\s+ul\s*\{/],
    ['ordered lists', /\.gravel-prose\s+ol\s*\{/],
    ['list items', /\.gravel-prose\s+li\s*\{/],
    ['blockquote', /\.gravel-prose\s+blockquote\s*\{/],
    ['inline code', /\.gravel-prose\s+code\s*\{/],
    ['code blocks', /\.gravel-prose\s+pre\s*\{/],
    ['links', /\.gravel-prose\s+a\s*\{/],
    ['paragraphs', /\.gravel-prose\s+p\s*\{/],
  ])('declares the %s rule (regression guard)', (_label, pattern) => {
    expect(css).toMatch(pattern)
  })
})
