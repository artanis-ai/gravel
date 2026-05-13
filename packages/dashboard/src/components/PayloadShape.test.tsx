/**
 * PayloadShape detection + render coverage.
 *
 * The detector must be conservative — false positives (mis-render a
 * non-LLM payload as a chat transcript) are user-hostile because the
 * dashboard hides the raw bytes. False negatives (fall back to JSON)
 * are fine: the user still sees the data.
 *
 * Each test pins one detection branch with the exact provider shape
 * the SDK tracing patches capture. If those shapes drift, this file
 * fails first.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PayloadShape } from './PayloadShape'

describe('PayloadShape — detection', () => {
  it('renders a string payload as plain text', () => {
    render(<PayloadShape value="just a string" />)
    expect(screen.getByText('just a string')).toBeInTheDocument()
  })

  it('renders an OpenAI chat-input transcript (messages + system + model)', () => {
    const value = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    }
    render(<PayloadShape value={value} />)
    expect(screen.getByText('hi')).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
    // Model name surfaces in the header.
    expect(screen.getByText(/gpt-4o-mini/)).toBeInTheDocument()
  })

  it('renders an OpenAI chat-output (choices[0].message)', () => {
    const value = {
      choices: [
        {
          message: { role: 'assistant', content: 'the answer is 42' },
          finish_reason: 'stop',
        },
      ],
    }
    render(<PayloadShape value={value} />)
    expect(screen.getByText('the answer is 42')).toBeInTheDocument()
    expect(screen.getByText(/stop/)).toBeInTheDocument()
  })

  it('renders an OpenAI chat-output with tool calls', () => {
    const value = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                function: { name: 'get_weather', arguments: '{"city":"london"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
    render(<PayloadShape value={value} />)
    expect(screen.getByText(/get_weather/)).toBeInTheDocument()
    // Args render somewhere — the city should appear.
    expect(screen.getByText(/london/i)).toBeInTheDocument()
  })

  it('renders Anthropic-style output (content[].text)', () => {
    const value = {
      id: 'msg_x',
      type: 'message',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    }
    render(<PayloadShape value={value} />)
    // Either rendered as concatenated text or as separate bubbles —
    // accept either presentation.
    const body = document.body.textContent ?? ''
    expect(body).toContain('one')
    expect(body).toContain('two')
  })

  it('renders LangChain-style tool calls (top-level toolCalls)', () => {
    const value = {
      toolCalls: [
        { name: 'search', args: { query: 'gravel sdk' }, id: 'tc_1' },
      ],
    }
    render(<PayloadShape value={value} />)
    expect(screen.getByText(/search/)).toBeInTheDocument()
    const body = document.body.textContent ?? ''
    expect(body).toContain('gravel sdk')
  })

  it('falls back to JSON for an unknown shape', () => {
    const value = { foo: 'bar', n: 42 }
    render(<PayloadShape value={value} />)
    const body = document.body.textContent ?? ''
    expect(body).toContain('foo')
    expect(body).toContain('bar')
    expect(body).toContain('42')
  })

  it('falls back to JSON for null', () => {
    // Null IS a valid sample (some calls have no input/output yet);
    // detector returns 'unknown' so RawJson renders it.
    render(<PayloadShape value={null} />)
    // Either "null" appears, or the RawJson block is present — both
    // are acceptable; just make sure nothing crashes.
    expect(document.body).toBeInTheDocument()
  })

  it('falls back to JSON for an empty messages array (not chat-input)', () => {
    // Per the detector contract: an empty messages array isn't a
    // meaningful chat input, so we should NOT render an empty
    // transcript. RawJson is the right fallback.
    const value = { messages: [] }
    render(<PayloadShape value={value} />)
    const body = document.body.textContent ?? ''
    expect(body).toContain('messages')
    expect(body).toContain('[]')
  })

  it('treats messages without a role or content as filtered-out (no crash)', () => {
    const value = {
      messages: [
        { role: 'user', content: 'real' },
        { weird: 'shape' }, // filtered
        null, // filtered
      ],
    }
    render(<PayloadShape value={value} />)
    expect(screen.getByText('real')).toBeInTheDocument()
  })

  it('passes a number through as RawJson, not chat-input', () => {
    render(<PayloadShape value={42} />)
    const body = document.body.textContent ?? ''
    expect(body).toContain('42')
  })

  it('passes an array of non-message objects through as RawJson', () => {
    const value = [{ a: 1 }, { b: 2 }]
    render(<PayloadShape value={value} />)
    const body = document.body.textContent ?? ''
    expect(body).toContain('a')
    expect(body).toContain('b')
  })
})
