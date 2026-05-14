/**
 * Behavioural tests for LangchainToolRenderer.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LangchainToolRenderer } from './LangchainTool'
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

describe('LangchainToolRenderer', () => {
  it('parses Python repr input_str (str(dict)) into structured rows', () => {
    // The exact shape LC Python emits for an agent tool call:
    // single quotes, capital `False`. Reviewer should see the
    // humanised key labels, not the raw repr.
    const input = {
      input_str:
        "{'contractor_name': 'Reliable Plumbing', 'issue_description': '1. **Subject** — Area behind toilet and pedestal sink.', 'is_emergency': False}",
      tool: 'schedule_contractor',
    }
    const output = { value: 'Appointment confirmed.' }
    const { container } = render(
      <RenderBoth renderer={LangchainToolRenderer} input={input} output={output} isFetch={false} />,
    )
    // Humanised key labels (humaniseKey maps snake_case → "Contractor Name")
    expect(container.textContent).toMatch(/Contractor Name/)
    expect(container.textContent).toMatch(/Issue Description/)
    expect(container.textContent).toMatch(/Is Emergency/)
    // is_emergency: False → rendered as the boolean chip "false" (NOT the raw "False")
    expect(container.textContent).not.toMatch(/'is_emergency'/)
    expect(container.textContent).toContain('Reliable Plumbing')
  })

  it('surfaces tool name + parsed arguments + parsed result', () => {
    const f = loadFixture('langchain-tool.json')
    const { container } = render(
      <RenderBoth renderer={LangchainToolRenderer} input={f.input} output={f.output} isFetch={false} />,
    )
    expect(container.textContent).toContain('get_weather')
    // input_str is a JSON-encoded string; we parse it before rendering
    expect(container.textContent).toContain('Edinburgh')
    // output is {"value": '{"temp_c":7,...}'} → parse the inner JSON
    expect(container.textContent).toMatch(/Temp C|temp_c/i)
    expect(container.textContent).toContain('overcast')
  })
})
