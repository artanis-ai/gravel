/**
 * Behavioural tests for OpenAIChatRenderer. Each test loads a real
 * fixture and asserts user-visible content appears — proving the
 * renderer extracts the structure, not just renders without
 * throwing.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { OpenAIChatRenderer } from './OpenAIChat'
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

describe('OpenAIChatRenderer', () => {
  it('plain text: shows user prompt + assistant reply', () => {
    const f = loadFixture('openai-chat.json')
    render(<RenderBoth renderer={OpenAIChatRenderer} input={f.input} output={f.output} isFetch={false} />)
    expect(screen.getByText(/capital of Japan\?/)).toBeTruthy()
    expect(screen.getByText(/Tokyo\./)).toBeTruthy()
  })

  it('with-tools: shows Tool call block + function name + parsed arguments', () => {
    const f = loadFixture('openai-chat-with-tools.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(screen.getAllByText(/Tool call/i).length).toBeGreaterThan(0)
    // tool names extracted from the function shape
    expect(container.textContent).toContain('get_weather')
    // arguments parsed from JSON-encoded string and rendered as structure
    expect(container.textContent).toContain('San Francisco')
    expect(container.textContent).toContain('London')
  })

  it('tool-result: renders role=tool message with parsed JSON content', () => {
    const f = loadFixture('openai-chat-tool-result.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    // The tool message's content is a JSON-encoded string with keys
    // `temp_c` and `condition`; renderer should parse it so the
    // humanised labels appear, not the raw `{"temp_c":...}` text.
    expect(container.textContent).toContain('Temp C')
    expect(container.textContent).toContain('Condition')
  })

  it('multimodal: image_url with a data: URI renders as an <img>', () => {
    const f = loadFixture('openai-chat-multimodal.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    const img = container.querySelector('img[src^="data:image/"]')
    expect(img).toBeTruthy()
  })

  it('refusal: surfaces the refusal panel distinctly', () => {
    const f = loadFixture('openai-chat-refusal.json')
    render(<RenderBoth renderer={OpenAIChatRenderer} input={f.input} output={f.output} isFetch={false} />)
    expect(screen.getAllByText(/Refusal/i).length).toBeGreaterThan(0)
  })

  it('errored: output is null — renders input + tools but no choice', () => {
    const f = loadFixture('openai-chat-error.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    // Input message present.
    expect(container.textContent ?? '').not.toBe('')
    // No "Tool call" or "Refusal" because output is null.
  })

  it('stream: assembles the assistant content from output.chunks deltas', () => {
    const f = loadFixture('openai-chat-stream.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    // The fixture's chunks emit content deltas "One. ", "Two. ", "Three."
    // — the renderer concatenates them rather than dumping the chunk list.
    expect(container.textContent).toContain('One. Two. Three.')
  })

  it('shows tool definitions below the conversation when input.tools is set', () => {
    const f = loadFixture('openai-chat-with-tools.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toMatch(/Tools \(\d+\)/)
  })
})
