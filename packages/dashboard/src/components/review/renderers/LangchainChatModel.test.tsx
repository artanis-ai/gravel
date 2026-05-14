import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LangchainChatModelRenderer } from './LangchainChatModel'
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

describe('LangchainChatModelRenderer', () => {
  it('renders LC `human` and `ai` messages with proper role mapping', () => {
    const f = loadFixture('langchain-chat-model.json')
    render(<RenderBoth renderer={LangchainChatModelRenderer} input={f.input} output={f.output} isFetch={false} />)
    // system + user + assistant content all present
    expect(screen.getByText(/Maple Ridge Apartments/)).toBeTruthy()
    expect(screen.getByText(/What time is trash pickup\?/)).toBeTruthy()
    expect(screen.getByText(/Tuesday and Friday/)).toBeTruthy()
    // role chips
    expect(screen.getAllByText(/System/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/User/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Assistant/i).length).toBeGreaterThan(0)
  })

  it('multi-batch input shows "Batch N of M" header', () => {
    const f = {
      input: {
        messages: [
          [{ content: 'first', type: 'human' }],
          [{ content: 'second', type: 'human' }],
        ],
      },
      output: {
        generations: [
          [{ text: 'a', message: { content: 'a', type: 'ai' } }],
          [{ text: 'b', message: { content: 'b', type: 'ai' } }],
        ],
      },
    }
    const { container } = render(
      <RenderBoth renderer={LangchainChatModelRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Batch 1 of 2')
    expect(container.textContent).toContain('Batch 2 of 2')
  })

  it('n>1 completions are labelled', () => {
    const f = {
      input: { messages: [[{ content: 'hi', type: 'human' }]] },
      output: {
        generations: [
          [
            { text: 'one', message: { content: 'one', type: 'ai' } },
            { text: 'two', message: { content: 'two', type: 'ai' } },
          ],
        ],
      },
    }
    const { container } = render(
      <RenderBoth renderer={LangchainChatModelRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('completion 1 of 2')
    expect(container.textContent).toContain('completion 2 of 2')
  })
})
