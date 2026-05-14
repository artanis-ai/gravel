/**
 * Behavioural tests for LangchainRetrieverRenderer.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LangchainRetrieverRenderer } from './LangchainRetriever'
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

describe('LangchainRetrieverRenderer', () => {
  it('surfaces query + documents + source/score metadata', () => {
    const f = loadFixture('langchain-retriever.json')
    const { container } = render(
      <RenderBoth renderer={LangchainRetrieverRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('quiet hours')
    expect(container.textContent).toMatch(/3 documents/)
    expect(container.textContent).toContain('Maple Ridge')
    // source shown in the per-doc header
    expect(container.textContent).toContain('lease.md')
    // score formatted to 2 dp
    expect(container.textContent).toMatch(/score: 0\.91/)
  })
})
