/**
 * Tests for the OpenAI auto-patch.
 *
 * We mock the `openai` module at module scope and a fake "Completions" class
 * stands in for the real one. The patch monkey-patches its prototype.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---- Mocks ---------------------------------------------------------------

class FakeChatCompletions {
  async create(params: any) {
    if (params?.__shouldThrow) {
      throw new Error('boom-from-openai')
    }
    if (params?.stream) {
      return makeFakeStream(['hello ', 'world'])
    }
    return {
      id: 'chatcmpl-test',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }
  }
}
class FakeChat {
  static Completions = FakeChatCompletions
  completions = new FakeChatCompletions()
}
class FakeResponses {
  async create(params: any) {
    if (params?.stream) return makeFakeStream(['r1', 'r2'])
    return { id: 'resp-test', output_text: 'ok', usage: { input_tokens: 4, output_tokens: 2 } }
  }
}
class FakeEmbeddings {
  async create(_params: any) {
    return { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 7 } }
  }
}
class FakeOpenAI {
  static Chat = FakeChat
  static Responses = FakeResponses
  static Embeddings = FakeEmbeddings
  chat = new FakeChat()
  responses = new FakeResponses()
  embeddings = new FakeEmbeddings()
}

function makeFakeStream(chunks: string[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < chunks.length) {
            const value = {
              choices: [{ delta: { content: chunks[i++] } }],
            }
            return { value, done: false as const }
          }
          return { value: undefined, done: true as const }
        },
      }
    },
  }
}

vi.mock('openai', () => ({ default: FakeOpenAI }))

// Spy on persistSample.
const persistSpy = vi.fn(async () => {})
vi.mock('../src/tracing/persist.js', () => ({
  persistSample: persistSpy,
  setGravelTracingConfig: vi.fn(),
  _resetGravelTracingForTests: vi.fn(),
}))

// ---- Tests --------------------------------------------------------------

describe('tracing/openai', () => {
  beforeEach(() => {
    persistSpy.mockClear()
    vi.resetModules()
    delete process.env.GRAVEL_TRACING_DISABLED
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('patches chat.completions.create and persists a trace', async () => {
    await import('../src/tracing/openai.js')
    // Allow the dynamic import inside the patch to settle.
    await new Promise((r) => setTimeout(r, 10))

    const client = new FakeOpenAI()
    const result = await client.chat.completions.create({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    })
    // Persist runs as void inside the patch — give it a tick.
    await new Promise((r) => setTimeout(r, 10))

    expect(result).toMatchObject({ id: 'chatcmpl-test' })
    expect(persistSpy).toHaveBeenCalledTimes(1)
    const payload = persistSpy.mock.calls[0]![0] as any
    expect(payload.name).toBe('openai.chat.completions.create')
    expect(payload.status).toBe('completed')
    expect(payload.provider).toBe('openai')
    expect(payload.model).toBe('gpt-test')
    expect(payload.tokensInput).toBe(5)
    expect(payload.tokensOutput).toBe(3)
    expect(payload.input).toMatchObject({ model: 'gpt-test' })
    expect(payload.output).toMatchObject({ id: 'chatcmpl-test' })
  })

  it('patches embeddings.create', async () => {
    await import('../src/tracing/openai.js')
    await new Promise((r) => setTimeout(r, 10))

    const client = new FakeOpenAI()
    await client.embeddings.create({ model: 'emb-test', input: 'hello' })
    await new Promise((r) => setTimeout(r, 10))

    const calls = persistSpy.mock.calls.filter(
      (c) => (c[0] as any).name === 'openai.embeddings.create',
    )
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const payload = calls[0]![0] as any
    expect(payload.model).toBe('emb-test')
    expect(payload.tokensInput).toBe(7)
  })

  it('does not patch when GRAVEL_TRACING_DISABLED=1', async () => {
    process.env.GRAVEL_TRACING_DISABLED = '1'
    // Reset the patched marker so re-importing actually attempts again.
    delete (FakeOpenAI as any)[Symbol.for('@artanis-ai/gravel/openai-patched')]
    await import('../src/tracing/openai.js')
    await new Promise((r) => setTimeout(r, 10))

    const client = new FakeOpenAI()
    await client.chat.completions.create({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(persistSpy).not.toHaveBeenCalled()
  })

  it('persists status=errored and re-throws on rejection', async () => {
    delete (FakeOpenAI as any)[Symbol.for('@artanis-ai/gravel/openai-patched')]
    await import('../src/tracing/openai.js')
    await new Promise((r) => setTimeout(r, 10))

    const client = new FakeOpenAI()
    await expect(
      client.chat.completions.create({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        __shouldThrow: true,
      } as any),
    ).rejects.toThrow('boom-from-openai')
    await new Promise((r) => setTimeout(r, 10))

    const errored = persistSpy.mock.calls
      .map((c) => c[0] as any)
      .filter((p) => p.status === 'errored')
    expect(errored.length).toBeGreaterThan(0)
    expect(errored[0].errorMessage).toContain('boom-from-openai')
  })

  it('tees a streaming response without consuming it', async () => {
    delete (FakeOpenAI as any)[Symbol.for('@artanis-ai/gravel/openai-patched')]
    await import('../src/tracing/openai.js')
    await new Promise((r) => setTimeout(r, 10))

    const client = new FakeOpenAI()
    const stream = await client.chat.completions.create({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    const collected: string[] = []
    for await (const chunk of stream as any) {
      collected.push((chunk as any).choices[0].delta.content)
    }
    // User must still see all chunks.
    expect(collected.join('')).toBe('hello world')
    await new Promise((r) => setTimeout(r, 10))

    const streamCall = persistSpy.mock.calls
      .map((c) => c[0] as any)
      .find((p) => p.states?.some((s: any) => s.key === 'stream_chunks'))
    expect(streamCall).toBeDefined()
    expect(streamCall.output).toMatchObject({ text: 'hello world', chunk_count: 2 })
  })
})
