/**
 * Behavioural tests for LangchainLLMRenderer.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LangchainLLMRenderer } from './LangchainLLM'
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

describe('LangchainLLMRenderer', () => {
  it('surfaces prompt + generation text + model config', () => {
    const f = loadFixture('langchain-llm.json')
    const { container } = render(
      <RenderBoth renderer={LangchainLLMRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('chemical symbol for sodium')
    expect(container.textContent).toContain('Na')
    // LLM config: model_name + temperature surfaced
    expect(container.textContent).toContain('gpt-3.5-turbo-instruct')
  })
})
