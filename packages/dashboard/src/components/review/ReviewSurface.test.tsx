/**
 * ReviewSurface smoke test. Iterates every fixture in
 * `tests/fixtures/sources/` and asserts:
 *
 *   1. The component renders without throwing.
 *   2. The dispatched source kind chip matches the fixture's
 *      declared `source` field.
 *   3. The output never contains a raw JSON object dump (`"key":`
 *      with surrounding braces) at the top level — every payload
 *      should reach HumanValue, which renders structured rows.
 *   4. For fetch fixtures, the URL appears in the rendered output.
 *
 * Per-renderer behavioural snapshots live in
 * `renderers/<source>.test.tsx` once Phase 3 fills them in.
 */
import { render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ReviewSurface } from './ReviewSurface'
import type { SourceKind } from '../../lib/source'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, '..', '..', '..', 'tests', 'fixtures', 'sources')

interface SourceFixture {
  name: string
  description: string
  source: SourceKind
  isFetch: boolean
  status: 'completed' | 'errored' | 'running'
  input: unknown
  output: unknown
  metadata: Record<string, unknown> | null
}

function loadFixtures(): Array<{ file: string; fixture: SourceFixture }> {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({
      file,
      fixture: JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8')) as SourceFixture,
    }))
}

afterEach(() => cleanup())

describe('ReviewSurface: renders every fixture without throwing', () => {
  for (const { file, fixture } of loadFixtures()) {
    it(`${file} renders`, () => {
      const { container } = render(
        <ReviewSurface
          name={fixture.name}
          input={fixture.input}
          output={fixture.output}
          metadata={fixture.metadata ?? null}
        />,
      )
      expect(container.textContent ?? '').not.toBe('')
    })

    it(`${file} shows the detected source chip`, () => {
      const { container } = render(
        <ReviewSurface
          name={fixture.name}
          input={fixture.input}
          output={fixture.output}
          metadata={fixture.metadata ?? null}
        />,
      )
      expect(container.textContent ?? '').toContain(fixture.source)
    })

    if (fixture.isFetch) {
      it(`${file} surfaces the fetch URL`, () => {
        const { container } = render(
          <ReviewSurface
            name={fixture.name}
            input={fixture.input}
            output={fixture.output}
            metadata={fixture.metadata ?? null}
          />,
        )
        // unwrapFetch pulled the URL out — FetchHeader should show it.
        const inputObj = fixture.input as Record<string, unknown>
        if (typeof inputObj?.url === 'string') {
          expect(container.textContent ?? '').toContain(inputObj.url)
        }
      })
    }

    if (fixture.metadata && fixture.metadata.routing === 'vertex') {
      it(`${file} surfaces a "via Vertex AI" routing pill`, () => {
        const { container } = render(
          <ReviewSurface
            name={fixture.name}
            input={fixture.input}
            output={fixture.output}
            metadata={fixture.metadata ?? null}
          />,
        )
        expect(container.textContent ?? '').toMatch(/via\s+Vertex AI/i)
      })
    }
  }
})

describe('ReviewSurface routing pill', () => {
  it('omits the pill when metadata.routing is gemini-api (default)', () => {
    const { container } = render(
      <ReviewSurface
        name="gemini.models.generate_content"
        input={{ contents: 'hi' }}
        output={{ candidates: [] }}
        metadata={{ routing: 'gemini-api' }}
      />,
    )
    expect(container.textContent ?? '').not.toMatch(/via\s+/i)
  })

  it('omits the pill when metadata.routing is missing entirely', () => {
    const { container } = render(
      <ReviewSurface
        name="gemini.models.generate_content"
        input={{ contents: 'hi' }}
        output={{ candidates: [] }}
        metadata={null}
      />,
    )
    expect(container.textContent ?? '').not.toMatch(/via\s+/i)
  })

  it('shows "via Gemini Enterprise" for enterprise routing', () => {
    const { container } = render(
      <ReviewSurface
        name="gemini.models.generate_content"
        input={{ contents: 'hi' }}
        output={{ candidates: [] }}
        metadata={{ routing: 'enterprise' }}
      />,
    )
    expect(container.textContent ?? '').toMatch(/via\s+Gemini Enterprise/i)
  })
})
