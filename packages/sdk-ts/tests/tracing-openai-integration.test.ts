/**
 * Integration test for the OpenAI auto-patch against the REAL `openai`
 * Node SDK. Mirrors `tracing-anthropic-integration.test.ts` and
 * `tracing-gemini-integration.test.ts`.
 *
 * The synthetic `tracing-openai.test.ts` injects a `FakeChat` /
 * `FakeEmbeddings` class via `vi.mock` and validates the wrapper's
 * logic in isolation. That can't catch SDK shape drift (the v0.7.0
 * Gemini own-property bug class). This test grounds the patch in
 * the actual SDK behaviour against a local HTTP server.
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
      const url = req.url ?? ''
      if (url.includes('/embeddings')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
            model: 'text-embedding-3-small',
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }),
        )
        return
      }
      // Default: chat completions
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve())
    server.listen(0, '127.0.0.1')
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  baseUrl = `http://127.0.0.1:${port}/v1`
  await import('../src/tracing/openai.js')
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  persistSpy.mockClear()
})

describe('OpenAI auto-patch against real openai SDK', () => {
  it('records exactly one row from chat.completions.create', async () => {
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: 'sk-test', baseURL: baseUrl })

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.choices[0].message.content).toBe('hello')

    await new Promise((r) => setTimeout(r, 50))

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const call = persistSpy.mock.calls[0][0] as {
      name: string
      status: string
      provider?: string
      tokensInput?: number
      tokensOutput?: number
    }
    expect(call.name).toBe('openai.chat.completions.create')
    expect(call.status).toBe('completed')
    expect(call.provider).toBe('openai')
    expect(call.tokensInput).toBe(5)
    expect(call.tokensOutput).toBe(1)
  })

  it('records exactly one row from embeddings.create', async () => {
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: 'sk-test', baseURL: baseUrl })

    const resp = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: 'vectorise me',
    })
    // Different openai SDK versions parse the embedding into either a
    // plain number[] or a typed Float32Array; only check it's present.
    expect(resp.data[0]).toBeDefined()
    expect(resp.model).toBe('text-embedding-3-small')

    await new Promise((r) => setTimeout(r, 50))

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const call = persistSpy.mock.calls[0][0] as { name: string; provider?: string }
    expect(call.name).toBe('openai.embeddings.create')
    expect(call.provider).toBe('openai')
  })

  it('sequential chat + embeddings do not double-record or leak fetch rows', async () => {
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: 'sk-test', baseURL: baseUrl })

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: 'vec',
    })

    await new Promise((r) => setTimeout(r, 50))

    const names = persistSpy.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names.filter((n) => n === 'openai.chat.completions.create')).toHaveLength(1)
    expect(names.filter((n) => n === 'openai.embeddings.create')).toHaveLength(1)
    expect(names).not.toContain('fetch:openai.chat.completions')
    expect(names).not.toContain('fetch:openai.embeddings')
  })
})
