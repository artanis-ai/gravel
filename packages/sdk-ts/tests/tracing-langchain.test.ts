/**
 * Tests for the Langchain auto-instrumentation.
 *
 * We mock @langchain/core/callbacks/{base,manager} with a minimal
 * `BaseCallbackHandler` class + a `setGlobalCallbackHandler` capture
 * function, then drive the captured handler manually as Langchain itself
 * would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeBaseCallbackHandler {
  name = 'fake'
}

let registeredHandler: any = null

vi.mock('@langchain/core/callbacks/base', () => ({
  BaseCallbackHandler: FakeBaseCallbackHandler,
}))
vi.mock('@langchain/core/callbacks/manager', () => ({
  setGlobalCallbackHandler: (h: any) => {
    registeredHandler = h
  },
}))

const persistSpy = vi.fn(async () => {})
vi.mock('../src/tracing/persist.js', () => ({
  persistTrace: persistSpy,
  setGravelTracingConfig: vi.fn(),
  _resetGravelTracingForTests: vi.fn(),
}))

const PATCHED_KEY = Symbol.for('@artanis-ai/gravel/langchain-patched')

/**
 * Poll until the langchain patch has finished its async dynamic-import +
 * handler registration. Replaces a flaky `setTimeout(10ms)` that was
 * timing-dependent on CI runners.
 */
async function waitForRegistration(timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (registeredHandler === null && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * Wait for `persistSpy` to have been invoked at least `n` times. Like
 * `waitForRegistration` but for the post-event persistence path which
 * also runs in a `.then()` chain off the user-facing handler call.
 */
async function waitForPersist(n = 1, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (persistSpy.mock.calls.length < n && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('tracing/langchain', () => {
  beforeEach(() => {
    persistSpy.mockClear()
    registeredHandler = null
    vi.resetModules()
    delete process.env.GRAVEL_TRACING_DISABLED
    delete (globalThis as any)[PATCHED_KEY]
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers a global callback handler', async () => {
    await import('../src/tracing/langchain.js')
    await waitForRegistration()
    expect(registeredHandler).toBeTruthy()
    expect(registeredHandler.name).toBe('gravel-tracer')
  })

  it('persists a trace on handleLLMEnd', async () => {
    await import('../src/tracing/langchain.js')
    await waitForRegistration()

    const llm = { id: ['llm', 'OpenAI'], modelName: 'gpt-test' }
    const runId = 'run-1'
    registeredHandler.handleLLMStart(llm, ['hello'], runId)
    registeredHandler.handleLLMEnd(
      {
        generations: [[{ text: 'world' }]],
        llmOutput: { tokenUsage: { promptTokens: 4, completionTokens: 2 } },
      },
      runId,
    )
    await waitForPersist()

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const payload = persistSpy.mock.calls[0]![0] as any
    expect(payload.name).toBe('langchain.llm.OpenAI')
    expect(payload.status).toBe('completed')
    expect(payload.model).toBe('gpt-test')
    expect(payload.tokensInput).toBe(4)
    expect(payload.tokensOutput).toBe(2)
  })

  it('persists status=errored on handleLLMError', async () => {
    await import('../src/tracing/langchain.js')
    await waitForRegistration()

    const runId = 'run-2'
    registeredHandler.handleLLMStart(
      { id: ['llm', 'OpenAI'], modelName: 'gpt-test' },
      ['hi'],
      runId,
    )
    registeredHandler.handleLLMError(new Error('boom-langchain'), runId)
    await waitForPersist()

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const payload = persistSpy.mock.calls[0]![0] as any
    expect(payload.status).toBe('errored')
    expect(payload.errorMessage).toContain('boom-langchain')
  })

  it('persists chain start/end', async () => {
    await import('../src/tracing/langchain.js')
    await waitForRegistration()

    const runId = 'run-3'
    registeredHandler.handleChainStart({ id: ['chain', 'MyChain'] }, { foo: 'bar' }, runId)
    registeredHandler.handleChainEnd({ result: 42 }, runId)
    await waitForPersist()

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const payload = persistSpy.mock.calls[0]![0] as any
    expect(payload.name).toBe('langchain.chain.MyChain')
    expect(payload.status).toBe('completed')
    expect(payload.input).toEqual({ foo: 'bar' })
    expect(payload.output).toEqual({ result: 42 })
  })

  it('GRAVEL_TRACING_DISABLED=1 prevents handler registration', async () => {
    process.env.GRAVEL_TRACING_DISABLED = '1'
    await import('../src/tracing/langchain.js')
    // Brief wait gives the dynamic import a chance to resolve before
    // asserting the handler is still null. We deliberately don't poll
    // (waitForRegistration would time out the full 2s) — the env-var
    // gate fires synchronously inside the patch module.
    await new Promise((r) => setTimeout(r, 50))
    expect(registeredHandler).toBeNull()
  })
})
