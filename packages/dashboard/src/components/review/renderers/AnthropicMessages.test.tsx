import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { AnthropicMessagesRenderer } from './AnthropicMessages'
import { RenderBoth } from './_testHarness'

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'sources',
)

function loadFixture(name: string): { input: unknown; output: unknown } {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'))
}

afterEach(() => cleanup())

describe('AnthropicMessagesRenderer', () => {
  it('plain: shows user prompt + assistant text', () => {
    const f = loadFixture('anthropic-messages.json')
    render(<RenderBoth renderer={AnthropicMessagesRenderer} input={f.input} output={f.output} isFetch={false} />)
    expect(screen.getByText(/capital of France\?/)).toBeTruthy()
    expect(screen.getByText(/The capital of France is Paris\./)).toBeTruthy()
  })

  it('top-level system field renders above the conversation', () => {
    const f = loadFixture('anthropic-messages-system.json')
    const { container } = render(
      <RenderBoth renderer={AnthropicMessagesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Maple Ridge concierge')
    expect(screen.getAllByText(/System/i).length).toBeGreaterThan(0)
  })

  it('with-tools: tool_use block renders with name + input', () => {
    const f = loadFixture('anthropic-messages-with-tools.json')
    const { container } = render(
      <RenderBoth renderer={AnthropicMessagesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(screen.getAllByText(/Tool use/i).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('get_weather')
    expect(container.textContent).toContain('Tokyo')
  })

  it('tool_result block on user message renders with the parsed JSON content', () => {
    const f = loadFixture('anthropic-messages-tool-result.json')
    const { container } = render(
      <RenderBoth renderer={AnthropicMessagesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(screen.getAllByText(/Tool result/i).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Temp C')
    expect(container.textContent).toContain('14')
  })

  it('image block (base64) renders an <img> with data URI', () => {
    const f = loadFixture('anthropic-messages-image.json')
    const { container } = render(
      <RenderBoth renderer={AnthropicMessagesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    const img = container.querySelector('img[src^="data:image/"]')
    expect(img).toBeTruthy()
  })

  it('citations chip appears on text blocks with citations[]', () => {
    const f = loadFixture('anthropic-messages-citations.json')
    const { container } = render(
      <RenderBoth renderer={AnthropicMessagesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(screen.getAllByText(/cite/i).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Maple Ridge Handbook')
  })

  it('streaming sample: shows the assembled output', () => {
    const f = loadFixture('anthropic-messages-stream.json')
    const { container } = render(
      <RenderBoth renderer={AnthropicMessagesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Red, blue, and yellow.')
  })

  it('errored sample: output null → renders input only without throwing', () => {
    const f = loadFixture('anthropic-messages-error.json')
    const { container } = render(
      <RenderBoth renderer={AnthropicMessagesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Hello!')
  })

  it('non-end_turn stop_reason shows as a caption on the assistant message', () => {
    const f = {
      input: { messages: [{ role: 'user', content: 'go on' }] },
      output: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'truncated' }],
        stop_reason: 'max_tokens',
      },
    }
    const { container } = render(
      <RenderBoth renderer={AnthropicMessagesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('stop: max_tokens')
  })
})
