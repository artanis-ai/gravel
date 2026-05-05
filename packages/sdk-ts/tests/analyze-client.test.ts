import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzePrompt, AnalyzeError } from '../src/analyze/client.js'

const ENV_KEYS = ['GRAVEL_API_KEY', 'GRAVEL_CONTROL_PLANE_URL']

describe('analyzePrompt', () => {
  const orig: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      orig[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (orig[k] === undefined) delete process.env[k]
      else process.env[k] = orig[k]
    }
    vi.restoreAllMocks()
  })

  it('throws when GRAVEL_API_KEY is missing', async () => {
    await expect(analyzePrompt({ prompt: 'hi' })).rejects.toBeInstanceOf(AnalyzeError)
  })

  it('posts to /api/analyze with bearer auth + body', async () => {
    process.env.GRAVEL_API_KEY = 'ak_test'
    process.env.GRAVEL_CONTROL_PLANE_URL = 'https://example.test'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ issues: [], usage: { inputTokens: 0, outputTokens: 0, tasks: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const r = await analyzePrompt({ prompt: 'You are a helpful assistant.' })
    expect(r.issues).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://example.test/api/analyze')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ak_test')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      prompt: 'You are a helpful assistant.',
    })
  })

  it('maps non-2xx to AnalyzeError', async () => {
    process.env.GRAVEL_API_KEY = 'ak_bad'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid or expired API key' }), { status: 401 }),
    )
    await expect(analyzePrompt({ prompt: 'x' })).rejects.toMatchObject({
      status: 401,
      body: { error: 'invalid or expired API key' },
    })
  })
})
