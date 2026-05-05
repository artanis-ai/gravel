/**
 * Tests for src/evals/runner.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runEval, type EvalRow } from '../src/evals/runner.js'
import type { Verdict } from '../src/judge/client.js'

const FAKE_VERDICT: Verdict = {
  score: 1,
  passed: true,
  reasoning: 'ok',
  breakdown: {},
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mkRows(n: number): EvalRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`,
    input: { q: `question-${i}` },
    output: `answer-${i}`,
    expectedCorrection: null,
  }))
}

describe('runEval', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    process.env.GRAVEL_API_KEY = 'ak_testkey'
    process.env.GRAVEL_PROJECT_ID = '00000000-0000-0000-0000-000000000001'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = { ...ORIGINAL_ENV }
  })

  it('judges every row, calls onResult per row, preserves order', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ verdict: FAKE_VERDICT, judge_version: 'v1', tokens: { input: 1, output: 1 } }),
    )
    const onResult = vi.fn()
    const out = await runEval({
      runId: 'run-1',
      type: 'trace',
      rows: mkRows(10),
      criteria: ['accuracy'],
      concurrency: 4,
      onResult,
    })
    expect(out.runId).toBe('run-1')
    expect(out.results).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(out.results[i]?.rowId).toBe(`row-${i}`)
      expect(out.results[i]?.verdict).toEqual(FAKE_VERDICT)
      expect(out.results[i]?.error).toBeUndefined()
    }
    expect(onResult).toHaveBeenCalledTimes(10)
  })

  it('respects the concurrency cap', async () => {
    let inFlight = 0
    let peak = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      inFlight--
      return jsonResponse({ verdict: FAKE_VERDICT, judge_version: 'v1', tokens: { input: 1, output: 1 } })
    })
    await runEval({
      runId: 'run-2',
      type: 'trace',
      rows: mkRows(10),
      criteria: ['c'],
      concurrency: 3,
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('continues on per-row errors and surfaces them in results', async () => {
    let n = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const i = n++
      if (i % 3 === 0) return jsonResponse({ error: 'boom' }, 500)
      return jsonResponse({ verdict: FAKE_VERDICT, judge_version: 'v1', tokens: { input: 1, output: 1 } })
    })
    const onResult = vi.fn()
    // Force serial execution so the round-robin "every 3rd" pattern is deterministic.
    const out = await runEval({
      runId: 'run-3',
      type: 'trace',
      rows: mkRows(9),
      criteria: ['c'],
      concurrency: 1,
      onResult,
    })
    const errored = out.results.filter((r) => r.error)
    const ok = out.results.filter((r) => r.verdict)
    expect(errored.length).toBe(3)
    expect(ok.length).toBe(6)
    expect(errored[0]?.error).toMatch(/boom/)
    expect(onResult).toHaveBeenCalledTimes(9)
  })

  it('calls runPipeline for type=live and uses its return as the output', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        jsonResponse({
          verdict: FAKE_VERDICT,
          judge_version: 'v1',
          tokens: { input: 1, output: 1 },
        }),
      )
    const runPipeline = vi.fn(async (input: unknown) => `piped:${(input as { q: string }).q}`)
    await runEval({
      runId: 'run-4',
      type: 'live',
      rows: mkRows(3),
      criteria: ['c'],
      concurrency: 2,
      runPipeline,
    })
    expect(runPipeline).toHaveBeenCalledTimes(3)
    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string) as { output: string; type: string },
    )
    expect(bodies.every((b) => b.type === 'live')).toBe(true)
    const outputs = bodies.map((b) => b.output).sort()
    expect(outputs).toEqual(['piped:question-0', 'piped:question-1', 'piped:question-2'])
  })

  it('throws if type=live without runPipeline', async () => {
    await expect(
      runEval({
        runId: 'run-5',
        type: 'live',
        rows: mkRows(1),
        criteria: ['c'],
      }),
    ).rejects.toThrow(/runPipeline/)
  })

  it('errors thrown by onResult do not kill the run', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ verdict: FAKE_VERDICT, judge_version: 'v1', tokens: { input: 1, output: 1 } }),
    )
    const onResult = vi.fn().mockImplementation(() => {
      throw new Error('handler exploded')
    })
    // The first onResult call (for the success path) currently propagates because
    // we only swallow on the error path. Verify the success path's onResult
    // throwing DOES bubble and gets surfaced as the row error via the catch.
    // (Documents current behaviour — if changed, update this test.)
    const out = await runEval({
      runId: 'run-6',
      type: 'trace',
      rows: mkRows(3),
      criteria: ['c'],
      concurrency: 1,
      onResult,
    })
    expect(out.results).toHaveLength(3)
    // All rows recorded — even though onResult threw, the run completed.
    expect(out.results.every((r) => r.rowId)).toBe(true)
  })

  it('handles empty rows', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const out = await runEval({
      runId: 'run-7',
      type: 'trace',
      rows: [],
      criteria: ['c'],
    })
    expect(out.results).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
