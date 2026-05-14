/**
 * Behavioural tests for VercelAITextRenderer.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { VercelAITextRenderer } from './VercelAIText'
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

describe('VercelAITextRenderer', () => {
  it('generateText: surfaces system + user + assistant text', () => {
    const f = loadFixture('vercel-ai-generate-text.json')
    const { container } = render(
      <RenderBoth renderer={VercelAITextRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Edinburgh')
    expect(container.textContent).toContain('Arthur')
    expect(container.textContent).toContain('eastern ridge')
  })

  it('streamText: surfaces the consolidated text', () => {
    const f = loadFixture('vercel-ai-stream-text.json')
    const { container } = render(
      <RenderBoth renderer={VercelAITextRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Royal Mile')
    expect(container.textContent).toContain('Hula Juice')
  })
})
