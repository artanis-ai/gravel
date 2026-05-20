/**
 * Integration test for the LangChain auto-instrumentation against
 * the REAL `@langchain/core` package.
 *
 * Why this exists separately from `tracing-langchain.test.ts`:
 * - the synthetic test mocks `BaseCallbackHandler` and drives our
 *   handler with hand-crafted Run objects (covers handler logic)
 * - this test runs an actual `RunnableLambda` through real LangChain
 *   dispatch, asserting the handler fires on its `onChainStart` /
 *   `onChainEnd` lifecycle hooks
 *
 * Caveat: @langchain/core v1+ removed `setGlobalCallbackHandler`, so
 * the gravel patch can't auto-register globally. Users on v1+ must
 * attach the exported `globalThis.gravelLangchainHandler` to their
 * chain via `chain.withConfig({ callbacks: [handler] })`. This test
 * exercises that path; v0.x customers stay covered via the legacy
 * auto-registration branch in the patch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const persistSpy = vi.fn(async () => {})
vi.mock('../src/tracing/persist.js', () => ({
  persistSample: persistSpy,
  _resetGravelTracingForTests: () => {},
  setGravelTracingConfig: () => {},
}))

beforeAll(async () => {
  // Triggers the patch's side-effect: registers the handler globally
  // when possible, falls back to `globalThis.gravelLangchainHandler`
  // export when the legacy global hook is missing.
  await import('../src/tracing/langchain.js')
  // The patch is fire-and-forget; await microtasks before the first test.
  await new Promise((r) => setTimeout(r, 50))
})

afterAll(() => {
  delete (globalThis as Record<string, unknown>).gravelLangchainHandler
})

beforeEach(() => {
  persistSpy.mockClear()
})

describe('LangChain auto-patch against real @langchain/core', () => {
  it('exposes the gravelLangchainHandler on globalThis for manual attach', () => {
    const handler = (globalThis as Record<string, unknown>).gravelLangchainHandler
    expect(handler).toBeDefined()
    expect((handler as { name: string }).name).toBe('gravel-tracer')
  })

  it('records a langchain.chain row when handler is passed via callbacks config', async () => {
    const { RunnableLambda } = await import('@langchain/core/runnables')
    const handler = (globalThis as Record<string, unknown>).gravelLangchainHandler

    const chain = new RunnableLambda({ func: (x: string) => x.toUpperCase() })
    const out = await chain.invoke('hello', { callbacks: [handler as never] })
    expect(out).toBe('HELLO')

    // Callback dispatch is async; let the handler flush.
    await new Promise((r) => setTimeout(r, 50))

    const names = persistSpy.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names.some((n) => n.startsWith('langchain.chain'))).toBe(true)
  })

  it.todo('records a langchain.chain row WITHOUT explicit callbacks on v1+ (auto-registration)')
  // This is the path the legacy patch covered on @langchain/core v0.x via
  // `setGlobalCallbackHandler`. v1+ removed that hook; auto-registration
  // requires monkey-patching Runnable subclass invoke/stream/batch methods,
  // which is a substantial follow-up. For now v1+ users attach manually.
})
