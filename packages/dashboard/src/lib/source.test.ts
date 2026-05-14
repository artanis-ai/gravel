/**
 * Pinning test: every fixture in `tests/fixtures/sources/` declares
 * the `source` value `detectSource` is expected to return for its
 * (name, input, output) triple. Iterating ensures we can't add a
 * new fixture variant without teaching `detectSource` about it, and
 * we can't refactor `detectSource` without breaking a fixture that
 * exercises a variant we care about.
 *
 * Read SOURCES.md before changing anything here — the catalogue is
 * the source of truth, fixtures pin it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { detectSource, stripFetchPrefix, unwrapFetch, type SourceKind } from './source.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, '..', '..', 'tests', 'fixtures', 'sources')

interface SourceFixture {
  name: string
  description: string
  source: SourceKind
  isFetch: boolean
  status: 'completed' | 'errored' | 'running'
  input: unknown
  output: unknown
  metadata: unknown
}

function loadFixtures(): Array<{ file: string; fixture: SourceFixture }> {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({
      file,
      fixture: JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8')) as SourceFixture,
    }))
}

describe('detectSource: every fixture is classified correctly', () => {
  const fixtures = loadFixtures()

  it('finds fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(30)
  })

  for (const { file, fixture } of fixtures) {
    it(`${file} → ${fixture.source}`, () => {
      const detected = detectSource(fixture.name, fixture.input, fixture.output)
      expect(detected, `${file} declared source=${fixture.source}, detected=${detected}`).toBe(
        fixture.source,
      )
    })
  }
})

describe('stripFetchPrefix', () => {
  it('removes the fetch: prefix', () => {
    expect(stripFetchPrefix('fetch:openai.chat.completions')).toEqual({
      name: 'openai.chat.completions',
      isFetch: true,
    })
  })
  it('passes through SDK trace names unchanged', () => {
    expect(stripFetchPrefix('openai.chat.completions.create')).toEqual({
      name: 'openai.chat.completions.create',
      isFetch: false,
    })
  })
})

describe('unwrapFetch', () => {
  it('unwraps the {url, method, body} input and {body} output for fetch samples', () => {
    const env = unwrapFetch(
      'fetch:openai.chat.completions',
      { url: 'https://api.openai.com/v1/chat/completions', method: 'POST', body: { model: 'x' } },
      { body: { id: 'abc' } },
    )
    expect(env.isFetch).toBe(true)
    expect(env.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(env.method).toBe('POST')
    expect(env.input).toEqual({ model: 'x' })
    expect(env.output).toEqual({ id: 'abc' })
  })

  it('captures non-2xx status from output without a body', () => {
    const env = unwrapFetch(
      'fetch:anthropic.messages',
      { url: 'https://api.anthropic.com/v1/messages', method: 'POST', body: {} },
      { status: 429, statusText: 'Too Many Requests' },
    )
    expect(env.status).toBe(429)
    expect(env.statusText).toBe('Too Many Requests')
  })

  it('passes through SDK samples without unwrapping', () => {
    const env = unwrapFetch(
      'openai.chat.completions.create',
      { messages: [{ role: 'user', content: 'hi' }] },
      { id: 'abc' },
    )
    expect(env.isFetch).toBe(false)
    expect(env.input).toEqual({ messages: [{ role: 'user', content: 'hi' }] })
    expect(env.output).toEqual({ id: 'abc' })
    expect(env.url).toBeUndefined()
  })

  it('survives a fetch sample where the body is missing', () => {
    const env = unwrapFetch(
      'fetch:openai.embeddings',
      { url: 'https://api.openai.com/v1/embeddings', method: 'POST' },
      { status: 500 },
    )
    expect(env.isFetch).toBe(true)
    expect(env.input).toEqual({
      url: 'https://api.openai.com/v1/embeddings',
      method: 'POST',
    })
    expect(env.output).toEqual({ status: 500 })
  })
})

describe('detectSource: unknown shapes fall through', () => {
  it('returns unknown for a made-up trace name', () => {
    expect(detectSource('weird.thing', {}, {})).toBe('unknown')
  })
  it('returns unknown for an empty name', () => {
    expect(detectSource('', {}, {})).toBe('unknown')
  })
  it('still returns unknown after fetch: prefix strip if the inner name is unknown', () => {
    expect(detectSource('fetch:weird.thing', {}, {})).toBe('unknown')
  })
})
