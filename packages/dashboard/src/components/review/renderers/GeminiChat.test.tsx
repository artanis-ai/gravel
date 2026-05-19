/**
 * Behavioural tests for GeminiChatRenderer.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { GeminiChatRenderer } from './GeminiChat'
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

describe('GeminiChatRenderer', () => {
  it('plain turn: surfaces user prompt + model reply', () => {
    const f = loadFixture('gemini-chat.json')
    const { container } = render(
      <RenderBoth renderer={GeminiChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('capital of Japan')
    expect(container.textContent).toContain('Tokyo.')
  })

  it('system instruction: surfaces config.system_instruction as a System message above the conversation', () => {
    const f = loadFixture('gemini-chat-system.json')
    const { container } = render(
      <RenderBoth renderer={GeminiChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('professional French translator')
    expect(container.textContent).toContain('Bonjour')
  })

  it('with tools: renders Tool call block with function_call name + args', () => {
    const f = loadFixture('gemini-chat-with-tools.json')
    const { container } = render(
      <RenderBoth renderer={GeminiChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toMatch(/Tool call/i)
    expect(container.textContent).toContain('get_weather')
    expect(container.textContent).toContain('Tokyo')
    // Tool def section
    expect(container.textContent).toMatch(/Tools \(1\)/)
  })

  it('tool result: renders function_response part as a Tool result block', () => {
    const f = loadFixture('gemini-chat-tool-result.json')
    const { container } = render(
      <RenderBoth renderer={GeminiChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toMatch(/Tool result/i)
    expect(container.textContent).toContain('get_weather')
    // The tool returned {temp_c: 14, condition: "clear"} — humanised key + value
    expect(container.textContent).toMatch(/Temp C|temp_c/i)
    expect(container.textContent).toContain('clear')
    // Final model reply
    expect(container.textContent).toContain('14°C')
  })

  it('multimodal: renders inline_data image as a clickable thumbnail', () => {
    const f = loadFixture('gemini-chat-multimodal.json')
    const { container } = render(
      <RenderBoth renderer={GeminiChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    const img = container.querySelector('img[src^="data:image/"]')
    expect(img).toBeTruthy()
    expect(container.textContent).toContain('A single black pixel')
  })

  it('stream: renders the assembled candidate text (chunks live in metadata.states)', () => {
    const f = loadFixture('gemini-chat-stream.json')
    const { container } = render(
      <RenderBoth renderer={GeminiChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('3')
    expect(container.textContent).toContain('2')
    expect(container.textContent).toContain('1')
  })

  it('error: output is null — renders input pane without throwing', () => {
    const f = loadFixture('gemini-chat-error.json')
    const { container } = render(
      <RenderBoth renderer={GeminiChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent ?? '').toContain('Some prompt that hit')
  })

  it('safety: shows the SAFETY finish reason as a caption and surfaces the Safety disclosure', () => {
    const f = loadFixture('gemini-chat-safety.json')
    const { container } = render(
      <RenderBoth renderer={GeminiChatRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toMatch(/finish: SAFETY/)
    // Disclosure header
    expect(container.textContent).toMatch(/Safety/)
    // The HIGH-rated category appears in the disclosure
    expect(container.textContent).toContain('HARM_CATEGORY_DANGEROUS_CONTENT')
    expect(container.textContent).toContain('Blocked')
  })

  it('accepts camelCase TS-shape too: finishReason / usageMetadata / functionCall', () => {
    const f = loadFixture('fetch-gemini-chat.json')
    // The fetch envelope is unwrapped by the ReviewSurface in production;
    // here we feed the inner `body` shapes directly.
    const input = (f.input as { body: unknown }).body
    const output = (f.output as { body: unknown }).body
    const { container } = render(
      <RenderBoth renderer={GeminiChatRenderer} input={input} output={output} isFetch />,
    )
    expect(container.textContent).toContain('Hello in one word')
    expect(container.textContent).toContain('Hi.')
  })
})
