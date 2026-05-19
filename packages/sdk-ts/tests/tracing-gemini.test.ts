/**
 * Tests for the Gemini (`@google/genai`) auto-patch.
 *
 * Mirrors `tracing-openai.test.ts`: a fake module mocked at scope, the patch
 * monkey-patches its prototype, and we assert against the captured
 * `persistSample` calls. Patch installs once at file scope (it's
 * idempotent-guarded by a global Symbol, plus its closure captures a
 * specific `gravelContext` instance — re-installing under `vi.resetModules`
 * would create stale closures pointing at a discarded AsyncLocalStorage).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ---- Mocks ---------------------------------------------------------------

class FakeModels {
  async generateContent(params: any) {
    if (params?.__shouldThrow) {
      throw new Error('boom-from-gemini')
    }
    return {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Tokyo.' }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 3,
        totalTokenCount: 15,
      },
      modelVersion: 'gemini-2.0-flash-001',
    }
  }

  async generateContentStream(_params: any) {
    return makeFakeStream(['Hello ', 'world'])
  }
}

class FakeGoogleGenAI {
  static Models = FakeModels
  models = new FakeModels()
}

function makeFakeStream(textChunks: string[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < textChunks.length) {
            const value = {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: textChunks[i++] }],
                  },
                },
              ],
            }
            return { value, done: false as const }
          }
          return { value: undefined, done: true as const }
        },
      }
    },
  }
}

vi.mock('@google/genai', () => ({
  GoogleGenAI: FakeGoogleGenAI,
  Models: FakeModels,
  default: { GoogleGenAI: FakeGoogleGenAI, Models: FakeModels },
}))

const persistSpy = vi.fn(async () => {})
vi.mock('../src/tracing/persist.js', () => ({
  persistSample: persistSpy,
  setGravelTracingConfig: vi.fn(),
  _resetGravelTracingForTests: vi.fn(),
}))

// ---- Tests --------------------------------------------------------------

beforeAll(async () => {
  // One-time patch install. The wrapper closes over `gravelContext` from
  // this module load; re-installing later would create stale closures.
  await import('../src/tracing/gemini.js')
  await new Promise((r) => setTimeout(r, 10))
})

describe('tracing/gemini', () => {
  beforeEach(() => {
    persistSpy.mockClear()
    delete process.env.GRAVEL_TRACING_DISABLED
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('patches generateContent and persists a trace', async () => {
    const client = new FakeGoogleGenAI()
    const result = await client.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: 'Capital of Japan?' }] }],
    })

    expect((result as any).candidates[0].content.parts[0].text).toBe('Tokyo.')
    expect(persistSpy).toHaveBeenCalledTimes(1)
    const call = persistSpy.mock.calls[0]![0] as any
    expect(call.name).toBe('gemini.models.generate_content')
    expect(call.status).toBe('completed')
    expect(call.model).toBe('gemini-2.0-flash')
    expect(call.provider).toBe('gemini')
    expect(call.tokensInput).toBe(12)
    expect(call.tokensOutput).toBe(3)
  })

  it('persists an errored trace when the SDK throws', async () => {
    const client = new FakeGoogleGenAI()
    await expect(
      client.models.generateContent({ model: 'gemini-x', contents: [], __shouldThrow: true }),
    ).rejects.toThrow('boom-from-gemini')

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const call = persistSpy.mock.calls[0]![0] as any
    expect(call.status).toBe('errored')
    expect(call.errorMessage).toContain('boom-from-gemini')
  })

  it('tees a streaming response and persists collapsed text + chunk_count', async () => {
    const client = new FakeGoogleGenAI()
    const stream = await client.models.generateContentStream({
      model: 'gemini-x',
      contents: [{ role: 'user', parts: [{ text: 'count' }] }],
    })

    const seen: unknown[] = []
    for await (const chunk of stream as AsyncIterable<unknown>) {
      seen.push(chunk)
    }
    expect(seen.length).toBe(2)

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const call = persistSpy.mock.calls[0]![0] as any
    expect(call.name).toBe('gemini.models.generate_content_stream')
    expect(call.status).toBe('completed')
    expect(call.output.text).toBe('Hello world')
    expect(call.output.chunk_count).toBe(2)
  })

  it('honours GRAVEL_TRACING_DISABLED=1', async () => {
    process.env.GRAVEL_TRACING_DISABLED = '1'

    const client = new FakeGoogleGenAI()
    await client.models.generateContent({ model: 'gemini-x', contents: [] })

    expect(persistSpy).not.toHaveBeenCalled()
  })

  it('respects gravelContext.runWithSdkTracingDisabled (LangChain wrapping)', async () => {
    const { gravelContext } = await import('../src/tracing/context.js')

    const client = new FakeGoogleGenAI()
    await gravelContext.runWithSdkTracingDisabled(async () => {
      await client.models.generateContent({ model: 'gemini-x', contents: [] })
    })

    expect(persistSpy).not.toHaveBeenCalled()
  })
})
