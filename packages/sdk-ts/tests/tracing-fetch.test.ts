/**
 * Tests for the raw-fetch auto-patch. Patches globalThis.fetch and asserts
 * the patcher records traces for OpenAI- and Anthropic-shaped HTTP calls
 * while passing non-LLM calls through untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// We mock persist before importing the patcher so we can assert what was
// fed in.
vi.mock('../src/tracing/persist.js', () => ({
  persistSample: vi.fn(async () => {}),
  setGravelTracingConfig: () => {},
  _resetGravelTracingForTests: () => {},
}))

const PATCHED_SYM = Symbol.for('@artanis-ai/gravel/fetch-patched')

describe('fetch auto-patch', () => {
  let originalFetch: typeof fetch | undefined

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    delete (globalThis as any)[PATCHED_SYM]
    vi.resetModules()
    const persistMod = await import('../src/tracing/persist.js')
    ;(persistMod.persistSample as any).mockClear?.()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch
    delete (globalThis as any)[PATCHED_SYM]
    vi.unstubAllGlobals()
  })

  it('records a trace for an openai-shape POST and forwards the response', async () => {
    const fakeFetch = vi.fn(async (_url: any, _init?: any) => {
      return new Response(
        JSON.stringify({
          id: 'mock',
          model: 'gpt-test',
          choices: [{ message: { content: 'hi' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    await import('../src/tracing/fetch.js')
    const persistMod = await import('../src/tracing/persist.js')

    const r = await globalThis.fetch('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'ping' }] }),
    })
    const json = await r.json()
    expect(json.choices[0].message.content).toBe('hi')

    // Allow the void persistSample promise to settle.
    await new Promise((r) => setTimeout(r, 10))

    expect(persistMod.persistSample).toHaveBeenCalledOnce()
    const arg = (persistMod.persistSample as any).mock.calls[0][0]
    expect(arg.name).toBe('fetch:openai.chat.completions')
    expect(arg.provider).toBe('openai')
    expect(arg.model).toBe('gpt-test')
    expect(arg.tokensInput).toBe(3)
    expect(arg.tokensOutput).toBe(2)
    expect(arg.status).toBe('completed')
  })

  it('records a trace for an anthropic-shape POST', async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'msg',
          model: 'claude-test',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    await import('../src/tracing/fetch.js')
    const persistMod = await import('../src/tracing/persist.js')

    await globalThis.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', messages: [], max_tokens: 100 }),
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(persistMod.persistSample).toHaveBeenCalledOnce()
    const arg = (persistMod.persistSample as any).mock.calls[0][0]
    expect(arg.name).toBe('fetch:anthropic.messages')
    expect(arg.provider).toBe('anthropic')
    expect(arg.tokensInput).toBe(5)
    expect(arg.tokensOutput).toBe(1)
  })

  it('does NOT trace non-LLM URLs', async () => {
    const fakeFetch = vi.fn(async () => new Response('ok', { status: 200 }))
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    await import('../src/tracing/fetch.js')
    const persistMod = await import('../src/tracing/persist.js')

    await globalThis.fetch('https://example.com/api/users')
    await new Promise((r) => setTimeout(r, 10))

    expect(persistMod.persistSample).not.toHaveBeenCalled()
    expect(fakeFetch).toHaveBeenCalledOnce()
  })

  it('respects fetchTracingDisabled context flag (set by SDK patches)', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    await import('../src/tracing/fetch.js')
    const persistMod = await import('../src/tracing/persist.js')
    const { gravelContext } = await import('../src/tracing/context.js')

    await gravelContext.runWithFetchTracingDisabled(async () => {
      await globalThis.fetch('https://example.com/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      })
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(persistMod.persistSample).not.toHaveBeenCalled()
  })

  it('records errored status when the response is non-2xx', async () => {
    const fakeFetch = vi.fn(async () => new Response('{"error":"bad"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    await import('../src/tracing/fetch.js')
    const persistMod = await import('../src/tracing/persist.js')

    await globalThis.fetch('https://example.com/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    await new Promise((r) => setTimeout(r, 10))

    const arg = (persistMod.persistSample as any).mock.calls[0][0]
    expect(arg.status).toBe('errored')
  })
})
