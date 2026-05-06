/**
 * Tests for the Anthropic auto-patch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeMessages {
  async create(params: any) {
    if (params?.__shouldThrow) throw new Error('boom-anthropic')
    if (params?.stream) return makeFakeAnthropicStream(['hi ', 'there'])
    return {
      id: 'msg-test',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 11, output_tokens: 4 },
    }
  }
  stream(_params: any) {
    return {
      [Symbol.asyncIterator]() {
        let i = 0
        const events = [{ type: 'message_start' }, { type: 'message_stop' }]
        return {
          async next() {
            if (i < events.length) return { value: events[i++], done: false as const }
            return { value: undefined, done: true as const }
          },
        }
      },
      async finalMessage() {
        return {
          id: 'msg-stream-test',
          content: [{ type: 'text', text: 'streamed' }],
          usage: { input_tokens: 9, output_tokens: 2 },
        }
      },
    }
  }
}

class FakeAnthropic {
  static Messages = FakeMessages
  messages = new FakeMessages()
}

function makeFakeAnthropicStream(deltas: string[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < deltas.length) {
            const value = {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: deltas[i++] },
            }
            return { value, done: false as const }
          }
          return { value: undefined, done: true as const }
        },
      }
    },
  }
}

vi.mock('@anthropic-ai/sdk', () => ({ default: FakeAnthropic }))

const persistSpy = vi.fn(async () => {})
vi.mock('../src/tracing/persist.js', () => ({
  persistTrace: persistSpy,
  setGravelTracingConfig: vi.fn(),
  _resetGravelTracingForTests: vi.fn(),
}))

const PATCHED_KEY = Symbol.for('@artanis-ai/gravel/anthropic-patched')

describe('tracing/anthropic', () => {
  beforeEach(() => {
    persistSpy.mockClear()
    vi.resetModules()
    delete process.env.GRAVEL_TRACING_DISABLED
    delete (FakeAnthropic as any)[PATCHED_KEY]
    // Restore prototypes between tests so the patch re-wraps fresh.
    delete (FakeMessages.prototype as any).create.__gravelWrapped
    delete (FakeMessages.prototype as any).stream.__gravelWrapped
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('patches messages.create non-streaming and persists the trace', async () => {
    await import('../src/tracing/anthropic.js')
    await new Promise((r) => setTimeout(r, 10))

    const client = new FakeAnthropic()
    const result = await client.messages.create({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(result).toMatchObject({ id: 'msg-test' })
    expect(persistSpy).toHaveBeenCalledTimes(1)
    const payload = persistSpy.mock.calls[0]![0] as any
    expect(payload.name).toBe('anthropic.messages.create')
    expect(payload.provider).toBe('anthropic')
    expect(payload.model).toBe('claude-test')
    expect(payload.tokensInput).toBe(11)
    expect(payload.tokensOutput).toBe(4)
    expect(payload.status).toBe('completed')
  })

  it('GRAVEL_TRACING_DISABLED=1 short-circuits the patch', async () => {
    process.env.GRAVEL_TRACING_DISABLED = '1'
    await import('../src/tracing/anthropic.js')
    await new Promise((r) => setTimeout(r, 10))
    const client = new FakeAnthropic()
    await client.messages.create({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(persistSpy).not.toHaveBeenCalled()
  })

  it('persists status=errored and re-throws on rejection', async () => {
    await import('../src/tracing/anthropic.js')
    await new Promise((r) => setTimeout(r, 10))
    const client = new FakeAnthropic()
    await expect(
      client.messages.create({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'x' }],
        __shouldThrow: true,
      } as any),
    ).rejects.toThrow('boom-anthropic')
    await new Promise((r) => setTimeout(r, 10))

    const errored = persistSpy.mock.calls
      .map((c) => c[0] as any)
      .filter((p) => p.status === 'errored')
    expect(errored.length).toBeGreaterThan(0)
    expect(errored[0].errorMessage).toContain('boom-anthropic')
  })

  it('tees streaming response', async () => {
    await import('../src/tracing/anthropic.js')
    await new Promise((r) => setTimeout(r, 10))
    const client = new FakeAnthropic()
    const stream = await client.messages.create({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    } as any)
    const collected: string[] = []
    for await (const ev of stream as any) {
      if ((ev as any).type === 'content_block_delta') collected.push((ev as any).delta.text)
    }
    expect(collected.join('')).toBe('hi there')
    await new Promise((r) => setTimeout(r, 10))

    const streamCall = persistSpy.mock.calls
      .map((c) => c[0] as any)
      .find((p) => p.states?.some((s: any) => s.key === 'stream_chunks'))
    expect(streamCall).toBeDefined()
    expect(streamCall.output).toMatchObject({ text: 'hi there' })
  })

  it('captures messages.stream finalMessage', async () => {
    await import('../src/tracing/anthropic.js')
    await new Promise((r) => setTimeout(r, 10))
    const client = new FakeAnthropic()
    const stream = client.messages.stream({ model: 'claude-test', messages: [] })
    await stream.finalMessage()
    await new Promise((r) => setTimeout(r, 20))

    const streamPersists = persistSpy.mock.calls
      .map((c) => c[0] as any)
      .filter((p) => p.name === 'anthropic.messages.stream')
    expect(streamPersists.length).toBeGreaterThan(0)
    expect(streamPersists[0].tokensInput).toBe(9)
    expect(streamPersists[0].tokensOutput).toBe(2)
  })
})
