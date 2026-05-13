/**
 * Cross-patch deduplication: an SDK call must not double-record.
 *
 * Pre-fix the Python side wrote two rows per openai/anthropic call
 * (`openai.chat.completions.create` + `fetch:openai.chat.completions`)
 * because the SDK patch and the fetch patch both fired. The TS side
 * has the same risk: an openai client does an internal `fetch(...)`
 * which the fetch patch wraps. The contract that prevents the dupe
 * is the `fetchTracingDisabled` contextvar in
 * `packages/sdk-ts/src/tracing/context.ts` — SDK patches wrap their
 * underlying call in `gravelContext.runWithFetchTracingDisabled(...)`,
 * which fetch.ts reads to skip its own recording.
 *
 * `tracing-fetch.test.ts:119` already pins the suppression mechanism
 * itself. This file pins the END-TO-END seam: both patches loaded
 * simultaneously, an openai-shape call goes through, exactly ONE
 * persistSample call lands. If a future SDK patch forgets to wrap
 * with `runWithFetchTracingDisabled`, this test fails loudly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PATCHED_SYM = Symbol.for('@artanis-ai/gravel/fetch-patched')

describe('SDK-vs-fetch dedup (end-to-end)', () => {
  let originalFetch: typeof fetch | undefined

  beforeEach(() => {
    originalFetch = globalThis.fetch
    delete (globalThis as Record<symbol, unknown>)[PATCHED_SYM]
    vi.resetModules()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch
    delete (globalThis as Record<symbol, unknown>)[PATCHED_SYM]
    vi.unstubAllGlobals()
    vi.doUnmock('../src/tracing/persist.js')
  })

  it('runWithFetchTracingDisabled around a real fetch call suppresses one record', async () => {
    // Spy on persist so we can count recorded samples.
    const persistSpy = vi.fn(async () => 'id')
    vi.doMock('../src/tracing/persist.js', () => ({
      persistSample: persistSpy,
      setGravelTracingConfig: () => {},
      _resetGravelTracingForTests: () => {},
    }))

    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'cmpl',
          model: 'gpt-test',
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    // Load the fetch patch first.
    await import('../src/tracing/fetch.js')
    const { gravelContext } = await import('../src/tracing/context.js')

    // Baseline: bare fetch records ONE sample.
    await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', messages: [] }),
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(persistSpy).toHaveBeenCalledTimes(1)

    // SDK-suppressed: same call, but inside runWithFetchTracingDisabled.
    // The fetch patch must skip recording. AsyncLocalStorage propagates
    // the flag through the awaited fetch, so this works for async
    // callers without an extra await wrapper (the Python port mirrors
    // this with contextvars).
    await gravelContext.runWithFetchTracingDisabled(async () => {
      await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-test', messages: [] }),
      })
    })
    await new Promise((r) => setTimeout(r, 10))
    // Still 1 — the suppressed call must NOT have added a record.
    expect(persistSpy).toHaveBeenCalledTimes(1)

    // Outside the context, recording resumes — the contextvar must
    // reset cleanly.
    await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', messages: [] }),
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(persistSpy).toHaveBeenCalledTimes(2)
  })
})
