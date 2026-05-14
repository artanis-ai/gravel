/**
 * Smoke tests for JsonTree. The contract is: NEVER render structured
 * data as a raw <pre> dump. Yousef's rule for the Review surface —
 * if it's JSON, it must render as a collapsible tree.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { JsonTree } from './JsonTree'

describe('JsonTree', () => {
  it('renders a small flat object inline', () => {
    render(<JsonTree value={{ model: 'gpt-4o-mini', tokens: 42 }} />)
    // Inline form: keys + values without expand toggle on a flat object
    // with <= 3 primitive keys.
    expect(screen.getByText('model:')).toBeTruthy()
    expect(screen.getByText('"gpt-4o-mini"')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
  })

  it('renders a deep object as collapsible tree with auto-open root', () => {
    const value = {
      id: 'chatcmpl-x',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'urgent' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 345, completion_tokens: 1 },
    }
    render(<JsonTree value={value} />)
    // No <pre> on the page — Yousef's rule: never raw JSON.
    expect(document.querySelectorAll('pre').length).toBe(0)
    // Top-level keys visible (root is auto-open).
    expect(screen.getByText('id:')).toBeTruthy()
    expect(screen.getByText('choices:')).toBeTruthy()
    expect(screen.getByText('usage:')).toBeTruthy()
  })

  it('arrays show length and collapse beyond depth 1', () => {
    render(<JsonTree value={{ items: [{ a: 1 }, { a: 2 }, { a: 3 }] }} />)
    // The `items` array has length 3 — node label includes the count.
    expect(screen.getByText(/items \[3\]/)).toBeTruthy()
  })

  it('clicking a closed object node expands it', () => {
    const value = {
      a: 1,
      nested: {
        b: 2,
        deep: { c: 3, d: 4, e: 5, f: 6 }, // 4 keys → not inline-eligible
      },
    }
    render(<JsonTree value={value} />)
    // `nested.deep` is at depth 2 — starts closed.
    const toggle = screen.getByText(/deep \{4\}/)
    expect(toggle).toBeTruthy()
    // Before click: `f` key (inside deep) is not in the DOM.
    expect(screen.queryByText('f:')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('f:')).toBeTruthy()
  })

  it('long strings truncate with a show-more affordance', () => {
    const long = 'a'.repeat(500)
    render(<JsonTree value={{ body: long }} />)
    expect(screen.getByText(/show 300 more chars/)).toBeTruthy()
  })

  it('null + boolean + empty-string render with distinct styling, never as raw "null" inside a <pre>', () => {
    render(<JsonTree value={{ a: null, b: true, c: '' }} />)
    expect(document.querySelectorAll('pre').length).toBe(0)
    expect(screen.getByText('null')).toBeTruthy()
    expect(screen.getByText('true')).toBeTruthy()
    expect(screen.getByText('""')).toBeTruthy()
  })
})
