/**
 * End-to-end regression coverage for the auto-tracing bootstrap.
 *
 * Pre-v0.5.22 the wizard installed `instrumentation.ts` ONLY for
 * Next.js hosts. Express / Fastify / Hono / generic-Node hosts had
 * the dashboard wired (`createGravelHandler(...)`) but nothing
 * imported `@artanis-ai/gravel/auto`, so the patches never installed
 * and zero traces ever landed — silent customer-visible failure,
 * same bug class as the Python adapters in v0.5.22.
 *
 * Mirror of `python/gravel/tests/test_tracing_bootstrap.py`. This
 * file pins:
 *
 *   1. `createGravelHandler` with a DATABASE_URL triggers the auto
 *      import as a side-effect, so the fetch patch is installed
 *      without an explicit `import '@artanis-ai/gravel/auto'` line.
 *   2. `GRAVEL_TRACING_DISABLED=1` short-circuits the side-effect
 *      import.
 *   3. End-to-end: a real openai-shape fetch lands as a captured
 *      sample after `createGravelHandler` is called. This is the
 *      test that catches the actual bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PATCHED_SYM = Symbol.for('@artanis-ai/gravel/fetch-patched')

describe('auto-tracing bootstrap (createGravelHandler side-effect)', () => {
  let originalFetch: typeof fetch | undefined
  let originalDisabled: string | undefined

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalDisabled = process.env.GRAVEL_TRACING_DISABLED
    delete (globalThis as Record<symbol, unknown>)[PATCHED_SYM]
    vi.resetModules()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch
    if (originalDisabled === undefined) {
      delete process.env.GRAVEL_TRACING_DISABLED
    } else {
      process.env.GRAVEL_TRACING_DISABLED = originalDisabled
    }
    delete (globalThis as Record<symbol, unknown>)[PATCHED_SYM]
    vi.unstubAllGlobals()
  })

  it('installs the fetch patch as a side-effect of createGravelHandler', async () => {
    // No explicit `import '@artanis-ai/gravel/auto'` — the wizard
    // doesn't emit one for non-Next.js hosts. Pre-fix this assertion
    // was False and the symbol stayed unset.
    const { createGravelHandler, _resetHandlerForTests } = await import('../src/handler/index.js')
    const { _resetGravelTracingForTests } = await import('../src/tracing/persist.js')
    _resetHandlerForTests()
    _resetGravelTracingForTests()

    createGravelHandler({
      config: {
        mountPath: '/admin/ai',
        database: { url: 'file::memory:?cache=shared' },
        auth: { defaultPassword: 'x' },
      },
    })

    // `void import('../auto.js')` is async; let microtasks drain so
    // the patch finishes installing before we assert.
    await new Promise((r) => setTimeout(r, 50))

    expect((globalThis as Record<symbol, unknown>)[PATCHED_SYM]).toBe(true)
  })

  it('respects GRAVEL_TRACING_DISABLED=1 — patch never installs', async () => {
    process.env.GRAVEL_TRACING_DISABLED = '1'
    const { createGravelHandler, _resetHandlerForTests } = await import('../src/handler/index.js')
    const { _resetGravelTracingForTests } = await import('../src/tracing/persist.js')
    _resetHandlerForTests()
    _resetGravelTracingForTests()

    createGravelHandler({
      config: {
        mountPath: '/admin/ai',
        database: { url: 'file::memory:?cache=shared' },
        auth: { defaultPassword: 'x' },
      },
    })

    await new Promise((r) => setTimeout(r, 50))

    expect((globalThis as Record<symbol, unknown>)[PATCHED_SYM]).toBeUndefined()
  })

  it('end-to-end: createGravelHandler then an openai-shape fetch records a sample', async () => {
    // The actual customer chain:
    //   1. host imports gravel.config / their setup file
    //   2. that calls `createGravelHandler({ config })`
    //   3. some downstream code does `fetch('https://api.openai.com/v1/chat/completions', ...)`
    //
    // Pre-fix step 2 didn't trigger auto.ts, so step 3 was untraced
    // and zero rows appeared in gravel_samples. This test asserts
    // the captured-sample sink receives one record.

    // Mock persist BEFORE importing the handler — vi.mock isn't
    // available inside test bodies, so swap via the resetModules /
    // dynamic-import pattern that tracing-fetch.test.ts uses.
    vi.doMock('../src/tracing/persist.js', () => ({
      persistSample: vi.fn(async () => 'sample-id'),
      setGravelTracingConfig: () => {},
      _resetGravelTracingForTests: () => {},
    }))

    const fakeFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'cmpl-bootstrap',
          object: 'chat.completion',
          model: 'gpt-4o-mini',
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    const { createGravelHandler, _resetHandlerForTests } = await import('../src/handler/index.js')
    _resetHandlerForTests()

    createGravelHandler({
      config: {
        mountPath: '/admin/ai',
        database: { url: 'file::memory:?cache=shared' },
        auth: { defaultPassword: 'x' },
      },
    })

    // Let the dynamic auto.js import + its further dynamic provider
    // imports settle. Two ticks should cover it.
    await new Promise((r) => setTimeout(r, 50))

    const persistMod = await import('../src/tracing/persist.js')
    expect((persistMod.persistSample as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)

    // Fire the LLM-shape fetch — the patched globalThis.fetch should
    // intercept it and call persistSample.
    const res = await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).model).toBe('gpt-4o-mini')

    // persistSample is `void`-called from the patch; let it settle.
    await new Promise((r) => setTimeout(r, 20))

    expect((persistMod.persistSample as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      1,
    )
    const arg = (persistMod.persistSample as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.provider).toBe('openai')
    expect(arg.model).toBe('gpt-4o-mini')
    expect(arg.status).toBe('completed')

    vi.doUnmock('../src/tracing/persist.js')
  })
})
