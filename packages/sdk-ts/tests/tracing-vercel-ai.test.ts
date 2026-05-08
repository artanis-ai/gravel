/**
 * Lighter test for the Vercel AI SDK wrapper.
 *
 * The actual `ai` package isn't installed in this monorepo. We mock it with
 * the four entrypoints and assert the wrapper passes through and records the
 * spec-shaped payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakeModule: any = {
  generateText: async (params: any) => ({
    text: 'hello',
    usage: { promptTokens: 3, completionTokens: 2 },
    finishReason: 'stop',
  }),
  generateObject: async (params: any) => ({
    object: { foo: 'bar' },
    usage: { promptTokens: 4, completionTokens: 1 },
  }),
  streamText: (params: any) => ({
    textStream: (async function* () {
      yield 'h'
      yield 'i'
    })(),
    text: Promise.resolve('hi'),
    usage: Promise.resolve({ promptTokens: 2, completionTokens: 2 }),
  }),
  streamObject: (params: any) => ({
    object: Promise.resolve({ ok: true }),
    usage: Promise.resolve({ promptTokens: 1, completionTokens: 1 }),
  }),
}

vi.mock('ai', () => fakeModule)

const persistSpy = vi.fn(async () => {})
vi.mock('../src/tracing/persist.js', () => ({
  persistSample: persistSpy,
  setGravelTracingConfig: vi.fn(),
  _resetGravelTracingForTests: vi.fn(),
}))

describe('tracing/vercel-ai', () => {
  beforeEach(() => {
    persistSpy.mockClear()
    vi.resetModules()
    delete process.env.GRAVEL_TRACING_DISABLED
    // Don't reset the per-fn __gravelWrapped flag — that's the idempotency
    // guard. The wrapper checks process.env.GRAVEL_TRACING_DISABLED at call
    // time, so a single wrap suffices for all tests in this file.
  })
  afterEach(() => vi.restoreAllMocks())

  it('wraps generateText and persists spec-shaped trace', async () => {
    const ai = await import('ai' as string)
    // Patch must run before user calls; await import of patcher.
    await import('../src/tracing/vercel-ai.js')
    await new Promise((r) => setTimeout(r, 10))

    const result = await (ai as any).generateText({
      model: { modelId: 'fake-model' },
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(result).toMatchObject({ text: 'hello' })
    expect(persistSpy).toHaveBeenCalledTimes(1)
    const payload = persistSpy.mock.calls[0]![0] as any
    expect(payload.name).toBe('vercel-ai.generateText')
    expect(payload.provider).toBe('vercel-ai')
    expect(payload.model).toBe('fake-model')
    expect(payload.tokensInput).toBe(3)
    expect(payload.tokensOutput).toBe(2)
    expect(payload.input).toMatchObject({ messages: [{ role: 'user', content: 'hi' }] })
    expect((payload.input as any).model).toBeUndefined()
    expect(payload.output).toMatchObject({ text: 'hello', finishReason: 'stop' })
  })

  it('wraps streamText and persists once stream usage promise resolves', async () => {
    const ai = await import('ai' as string)
    await import('../src/tracing/vercel-ai.js')
    await new Promise((r) => setTimeout(r, 10))

    const result = (ai as any).streamText({
      model: { modelId: 'fake-model' },
      prompt: 'hi',
    })
    expect(result).toBeTruthy()
    // Allow the attached observer to consume the usage promise.
    await new Promise((r) => setTimeout(r, 30))

    const streamPersists = persistSpy.mock.calls
      .map((c) => c[0] as any)
      .filter((p) => p.name === 'vercel-ai.streamText')
    expect(streamPersists.length).toBe(1)
    expect(streamPersists[0].tokensInput).toBe(2)
    expect(streamPersists[0].tokensOutput).toBe(2)
    expect(streamPersists[0].output).toEqual({ text: 'hi' })
  })

  it('GRAVEL_TRACING_DISABLED=1 short-circuits', async () => {
    process.env.GRAVEL_TRACING_DISABLED = '1'
    const ai = await import('ai' as string)
    await import('../src/tracing/vercel-ai.js')
    await new Promise((r) => setTimeout(r, 10))
    await (ai as any).generateText({ model: { modelId: 'm' }, prompt: 'x' })
    await new Promise((r) => setTimeout(r, 10))
    expect(persistSpy).not.toHaveBeenCalled()
  })
})
