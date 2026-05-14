import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LangchainChainRenderer } from './LangchainChain'
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

describe('LangchainChainRenderer', () => {
  it('inputs.messages → chat; output.messages → final assistant bubble', () => {
    const f = loadFixture('langchain-chain-messages.json')
    const { container } = render(
      <RenderBoth renderer={LangchainChainRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('What are the quiet hours?')
    expect(container.textContent).toContain('Hi Sarah! What can I help with?')
    // The final reply is rendered as an assistant bubble.
    expect(screen.getAllByText(/Assistant/i).length).toBeGreaterThan(0)
  })

  it('single LCMessage input renders as one bubble; structured output renders as labelled chip', () => {
    const f = loadFixture('langchain-chain-single-message.json')
    const { container } = render(
      <RenderBoth renderer={LangchainChainRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    // The LC AIMessage content is a JSON-encoded string of the same
    // structured value — renderer parses it and shows humanised keys
    // instead of the raw `{"is_greeting":true}` text.
    expect(container.textContent).toContain('Is Greeting')
  })

  it('list-of-mixed input renders each entry; structured output as chip', () => {
    const f = loadFixture('langchain-chain-structured-output.json')
    const { container } = render(
      <RenderBoth renderer={LangchainChainRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Decide if the tenant')
    expect(container.textContent).toContain('Maple Ridge Apartments')
    expect(container.textContent).toContain('Is Greeting')
    expect(container.textContent).toContain('true')
  })

  it('vars+messages input shows the Variables strip + the chat', () => {
    const f = loadFixture('langchain-chain-vars-and-messages.json')
    const { container } = render(
      <RenderBoth renderer={LangchainChainRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Variables')
    expect(container.textContent).toContain('Is Greeting')
    // The output `{value: 'greeting_reply'}` renders as chip with label "Value".
    expect(container.textContent).toContain('Value')
    expect(container.textContent).toContain('greeting_reply')
  })

  it('string-value output renders as a Value chip and shows vars', () => {
    const f = loadFixture('langchain-chain-string-value.json')
    const { container } = render(
      <RenderBoth renderer={LangchainChainRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('Variables')
    expect(container.textContent).toContain('Topic')
    expect(container.textContent).toContain('Value')
    expect(container.textContent).toContain('Strawberry, vanilla, and pistachio.')
  })

  it('never JSON-dumps an unexpected shape', () => {
    const { container } = render(
      <RenderBoth
        renderer={LangchainChainRenderer}
        input={{ inputs: { x: 1, y: [1, 2, 3] } }}
        output={{ surprise: 'yes' }}
        isFetch={false}
      />,
    )
    expect(container.textContent).toContain('Variables')
    expect(container.textContent).toContain('Surprise')
    expect(container.textContent).toContain('yes')
  })
})
