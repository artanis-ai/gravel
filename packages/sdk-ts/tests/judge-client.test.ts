/**
 * Tests for src/judge/client.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { judgeCall, JudgeError, type Verdict } from '../src/judge/client.js'

const FAKE_VERDICT: Verdict = {
  score: 0.87,
  passed: true,
  reasoning: 'looks good',
  breakdown: { coherence: { score: 0.9, reasoning: 'fluent' } },
}

const FAKE_RESPONSE = {
  verdict: FAKE_VERDICT,
  judge_version: 'v1',
  tokens: { input: 100, output: 50 },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('judgeCall', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env.GRAVEL_API_KEY = 'ak_testkey'
    process.env.GRAVEL_PROJECT_ID = '00000000-0000-0000-0000-000000000001'
    delete process.env.GRAVEL_CONTROL_PLANE_URL
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = { ...ORIGINAL_ENV }
  })

  it('sends correctly snake_cased body, default URL, and bearer header', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(FAKE_RESPONSE))

    const verdict = await judgeCall({
      type: 'trace',
      input: { messages: [{ role: 'user', content: 'hi' }] },
      output: 'hello',
      expectedCorrection: null,
      promptContext: 'system prompt here',
      criteria: ['accuracy', 'tone'],
    })

    expect(verdict).toEqual(FAKE_VERDICT)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const callArgs = fetchMock.mock.calls[0]!
    expect(callArgs[0]).toBe('https://gravel.artanis.ai/api/judge')
    const init = callArgs[1] as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ak_testkey')
    expect(headers['content-type']).toBe('application/json')

    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      project_id: '00000000-0000-0000-0000-000000000001',
      type: 'trace',
      input: { messages: [{ role: 'user', content: 'hi' }] },
      output: 'hello',
      expected_correction: null,
      prompt_context: 'system prompt here',
      criteria: ['accuracy', 'tone'],
      judge_version: 'auto',
    })
  })

  it('forwards judgeVersion override', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(FAKE_RESPONSE))
    await judgeCall({
      type: 'live',
      input: 'q',
      output: 'a',
      expectedCorrection: 'better a',
      criteria: ['x'],
      judgeVersion: 'v2',
    })
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    )
    expect(body.judge_version).toBe('v2')
    expect(body.prompt_context).toBeNull()
  })

  it('respects controlPlaneUrl override and trims trailing slash', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(FAKE_RESPONSE))
    await judgeCall(
      {
        type: 'trace',
        input: 'i',
        output: 'o',
        expectedCorrection: null,
        criteria: ['c'],
      },
      { controlPlaneUrl: 'http://localhost:3000/' },
    )
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:3000/api/judge')
  })

  it('throws JudgeError with message and status on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'invalid_api_key' }, 401),
    )
    await expect(
      judgeCall({
        type: 'trace',
        input: 'i',
        output: 'o',
        expectedCorrection: null,
        criteria: ['c'],
      }),
    ).rejects.toMatchObject({
      name: 'JudgeError',
      status: 401,
      message: 'invalid_api_key',
    })
  })

  it('throws JudgeError on 400 with details body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'bad_request', details: { project_id: 'invalid' } }, 400),
    )
    await expect(
      judgeCall({
        type: 'trace',
        input: 'i',
        output: 'o',
        expectedCorrection: null,
        criteria: ['c'],
      }),
    ).rejects.toBeInstanceOf(JudgeError)
  })

  it('throws clearly when GRAVEL_API_KEY missing', async () => {
    delete process.env.GRAVEL_API_KEY
    await expect(
      judgeCall({
        type: 'trace',
        input: 'i',
        output: 'o',
        expectedCorrection: null,
        criteria: ['c'],
      }),
    ).rejects.toThrow(/GRAVEL_API_KEY/)
  })

  it('throws clearly when GRAVEL_PROJECT_ID missing', async () => {
    delete process.env.GRAVEL_PROJECT_ID
    await expect(
      judgeCall({
        type: 'trace',
        input: 'i',
        output: 'o',
        expectedCorrection: null,
        criteria: ['c'],
      }),
    ).rejects.toThrow(/GRAVEL_PROJECT_ID/)
  })

  it('aborts on timeout', async () => {
    // Simulate a fetch that respects AbortSignal: rejects with AbortError when aborted.
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal!
        signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    await expect(
      judgeCall(
        {
          type: 'trace',
          input: 'i',
          output: 'o',
          expectedCorrection: null,
          criteria: ['c'],
        },
        { timeoutMs: 10 },
      ),
    ).rejects.toThrow(/timed out after 10ms/)
  })

  it('uses 30s default timeout', async () => {
    // Sanity: timer should not fire on a fast response. Fakes confirm the default.
    vi.useFakeTimers()
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(FAKE_RESPONSE))
      await judgeCall({
        type: 'trace',
        input: 'i',
        output: 'o',
        expectedCorrection: null,
        criteria: ['c'],
      })
      // First setTimeout call is the abort timer.
      const firstCall = setTimeoutSpy.mock.calls.find((c) => c[1] === 30_000)
      expect(firstCall).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('integration: live judge endpoint', () => {
  it.skipIf(!process.env.GRAVEL_INTEGRATION)(
    'hits the real control plane',
    async () => {
      const verdict = await judgeCall({
        type: 'trace',
        input: { messages: [{ role: 'user', content: 'What is 2+2?' }] },
        output: '4',
        expectedCorrection: null,
        criteria: ['accuracy'],
      })
      expect(verdict).toMatchObject({
        score: expect.any(Number),
        passed: expect.any(Boolean),
        reasoning: expect.any(String),
        breakdown: expect.any(Object),
      })
    },
    60_000,
  )
})
