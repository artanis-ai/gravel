/**
 * Integration test for the Anthropic auto-patch against the REAL
 * `@anthropic-ai/sdk` Node SDK. Mirrors `tracing-gemini-integration.test.ts`.
 *
 * Why this exists separately from `tracing-anthropic.test.ts`:
 * - the synthetic test uses `vi.mock` to inject a `FakeMessages` class,
 *   which validates the wrapper's logic in isolation
 * - this test runs against the actual SDK behind a local HTTP server,
 *   catching the class of bug `vi.mock` can never catch (SDK shape
 *   drift, .parse() / .stream() methods being missing or wrapped
 *   differently than expected). v0.7.0 Gemini shipped a no-op patch
 *   because the SDK's own-property assignment defeated a prototype-
 *   level patch; the synth test was happy.
 *
 * v0.9.2 adds .parse() patching (Python had it from v0.9.1; TS was
 * silently un-patched until Claude's de_platform audit caught the
 * cross-stack drift). This test pins the patch's behaviour against the
 * real SDK.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'

const persistSpy = vi.fn(async () => {})
vi.mock('../src/tracing/persist.js', () => ({
  persistSample: persistSpy,
  _resetGravelTracingForTests: () => {},
  setGravelTracingConfig: () => {},
}))

let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      // Realistic Anthropic Messages API response shape.
      const out = {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: '{"answer":"ok"}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 5 },
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve())
    server.listen(0, '127.0.0.1')
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  // Install the patch against the real @anthropic-ai/sdk.
  await import('../src/tracing/anthropic.js')
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  persistSpy.mockClear()
})

describe('Anthropic auto-patch against real @anthropic-ai/sdk', () => {
  it('records exactly one row from messages.create against the real SDK', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: 'sk-test', baseURL: baseUrl })

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect((response.content[0] as { text: string }).text).toBe('{"answer":"ok"}')

    await new Promise((r) => setTimeout(r, 50))

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const call = persistSpy.mock.calls[0][0] as {
      name: string
      status: string
      provider?: string
      tokensInput?: number
      tokensOutput?: number
    }
    expect(call.name).toBe('anthropic.messages.create')
    expect(call.status).toBe('completed')
    expect(call.provider).toBe('anthropic')
    expect(call.tokensInput).toBe(7)
    expect(call.tokensOutput).toBe(5)
  })

  it('records exactly one row from messages.parse against the real SDK (v0.9.2 patch)', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: 'sk-test', baseURL: baseUrl })

    // .parse() may not exist on older SDK versions; only assert when it does.
    const proto = (client.messages as unknown as { constructor: { prototype: object } })
      .constructor.prototype as Record<string, unknown>
    if (typeof proto.parse !== 'function') {
      console.warn('SDK lacks Messages.prototype.parse; skipping parse assertion')
      return
    }

    // The mock returns plain JSON content; .parse() may raise if it
    // can't coerce to the requested schema. We don't care about the
    // result, only that the row records.
    try {
      // @ts-expect-error: parse signature differs across SDK versions
      await client.messages.parse({
        model: 'claude-sonnet-4-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'json me' }],
      })
    } catch {
      // Mock content can't parse; row still records (status=errored is fine).
    }

    await new Promise((r) => setTimeout(r, 50))

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const call = persistSpy.mock.calls[0][0] as {
      name: string
      provider?: string
    }
    expect(call.name).toBe('anthropic.messages.parse')
    expect(call.provider).toBe('anthropic')
  })

  it('sequential create + parse do not double-record', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: 'sk-test', baseURL: baseUrl })
    const proto = (client.messages as unknown as { constructor: { prototype: object } })
      .constructor.prototype as Record<string, unknown>

    await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    })

    if (typeof proto.parse === 'function') {
      try {
        // @ts-expect-error: parse signature differs across SDK versions
        await client.messages.parse({
          model: 'claude-sonnet-4-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'json' }],
        })
      } catch {
        // ignore
      }
    }

    await new Promise((r) => setTimeout(r, 50))

    const names = persistSpy.mock.calls.map((c) => (c[0] as { name: string }).name)
    // No fetch row should leak; fetch_tracing_disabled is in effect.
    expect(names).not.toContain('fetch:anthropic.messages')
    expect(names.filter((n) => n === 'anthropic.messages.create')).toHaveLength(1)
  })
})
