/**
 * Behavioural tests for OpenAIResponsesRenderer.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { OpenAIResponsesRenderer } from './OpenAIResponses'
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

describe('OpenAIResponsesRenderer', () => {
  it('plain message: surfaces user prompt + assistant reply', () => {
    const f = loadFixture('openai-responses.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIResponsesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('capital of Japan')
    expect(container.textContent).toContain('Tokyo.')
  })

  it('function_call output item: renders a Tool call block with the function name', () => {
    const f = loadFixture('openai-responses-function-call.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIResponsesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toMatch(/Tool call/i)
    expect(container.textContent).toContain('get_weather')
    expect(container.textContent).toContain('Tokyo')
  })

  it('function_call_output input item: pairs back to its call via call_id', () => {
    const f = loadFixture('openai-responses-function-call-output.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIResponsesRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('call_01responsesTokyo')
    // Tool result content: temp_c / condition (parsed from the JSON string).
    expect(container.textContent).toMatch(/Temp C|temp_c/i)
    expect(container.textContent).toContain('14°C')
  })
})
