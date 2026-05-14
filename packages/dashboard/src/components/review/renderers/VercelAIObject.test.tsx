/**
 * Behavioural tests for VercelAIObjectRenderer.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { VercelAIObjectRenderer } from './VercelAIObject'
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

describe('VercelAIObjectRenderer', () => {
  it('generateObject: surfaces the structured output value', () => {
    const f = loadFixture('vercel-ai-generate-object.json')
    const { container } = render(
      <RenderBoth renderer={VercelAIObjectRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    // Schema card is present.
    expect(container.textContent).toMatch(/Schema/i)
    // Structured value humanised: humaniseKey turns `name` into `Name`, etc.
    expect(container.textContent).toContain('flat white')
    expect(container.textContent).toContain('almond croissant')
  })

  it('streamObject: surfaces the consolidated object value', () => {
    const f = loadFixture('vercel-ai-stream-object.json')
    const { container } = render(
      <RenderBoth renderer={VercelAIObjectRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Edinburgh')
    expect(container.textContent).toContain("Arthur's Seat")
  })
})
