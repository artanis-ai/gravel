/**
 * Behavioural tests for OpenAIEmbeddingsRenderer.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { OpenAIEmbeddingsRenderer } from './OpenAIEmbeddings'
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

describe('OpenAIEmbeddingsRenderer', () => {
  it('single: renders the input string + vector dimensionality', () => {
    const f = loadFixture('openai-embeddings-single.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIEmbeddingsRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('leaking ceiling')
    // dim is 4 in fixture (truncated for readability)
    expect(container.textContent).toMatch(/4-d vector/)
  })

  it('batch: shows N inputs and N output rows', () => {
    const f = loadFixture('openai-embeddings-batch.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIEmbeddingsRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Leaking ceiling')
    expect(container.textContent).toContain('Door handle broken')
    expect(container.textContent).toContain('Boiler making')
    // 3 vector rows: indices 0, 1, 2
    expect(container.textContent).toMatch(/index #0/)
    expect(container.textContent).toMatch(/index #1/)
    expect(container.textContent).toMatch(/index #2/)
  })

  it('tokens: renders pre-encoded input as a token-count summary', () => {
    const f = loadFixture('openai-embeddings-tokens.json')
    const { container } = render(
      <RenderBoth renderer={OpenAIEmbeddingsRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toMatch(/4 tokens \(pre-encoded\)/)
    // encoding format is shown
    expect(container.textContent).toContain('float')
  })
})
