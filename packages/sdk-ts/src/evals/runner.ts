/**
 * Eval runner: iterate dataset rows, optionally execute the host pipeline, and
 * call the judge for each row with bounded concurrency.
 *
 * Per-row failures are collected — the run never throws mid-loop. Callers can
 * stream results into their own DB via `onResult`.
 *
 * Spec: gravel-cloud/docs/spec/api-surface.md §6 — evals.
 */
import { judgeCall, JudgeError, type JudgeCallOptions, type JudgeType, type Verdict } from '../judge/client.js'

export interface EvalRow {
  id: string
  input: unknown
  /** Required for `type='trace'`. Ignored for `type='live'` (overridden by runPipeline). */
  output?: unknown
  expectedCorrection: string | null
  promptContext?: string | null
}

export interface EvalResult {
  rowId: string
  verdict: Verdict | null
  error?: string
}

export interface RunEvalOptions {
  /** Caller-supplied (typically a db row id) so callers can correlate streams. */
  runId: string
  type: JudgeType
  rows: EvalRow[]
  criteria: string[]
  /** Required iff type === 'live'. Called with row.input; return value becomes the judged output. */
  runPipeline?: (input: unknown) => Promise<unknown> | unknown
  /** Default 4. */
  concurrency?: number
  /** Override judge version. Forwarded to judgeCall. Default 'auto'. */
  judgeVersion?: string
  /** Streaming callback fired after each row (success or error). */
  onResult?: (r: { rowId: string; verdict: Verdict | null; error?: Error }) => void | Promise<void>
  /** Forwarded to judgeCall (apiKey/projectId/url/timeout/fetch overrides). */
  judgeOptions?: JudgeCallOptions
}

export interface RunEvalReturn {
  runId: string
  results: EvalResult[]
}

/**
 * Bounded-concurrency runner. Resolves once every row has been judged (or
 * errored). Order of `results` matches the order of `opts.rows`.
 */
export async function runEval(opts: RunEvalOptions): Promise<RunEvalReturn> {
  const { runId, type, rows, criteria } = opts
  const concurrency = Math.max(1, opts.concurrency ?? 4)

  if (type === 'live' && typeof opts.runPipeline !== 'function') {
    throw new Error("runEval: type='live' requires opts.runPipeline")
  }

  const results: EvalResult[] = new Array(rows.length)
  let cursor = 0

  async function processRow(index: number): Promise<void> {
    const row = rows[index]
    if (!row) return
    try {
      let output: unknown
      if (type === 'live') {
        // Non-null asserted above.
        output = await opts.runPipeline!(row.input)
      } else {
        output = row.output
      }

      const verdict = await judgeCall(
        {
          type,
          input: row.input,
          output,
          expectedCorrection: row.expectedCorrection,
          promptContext: row.promptContext ?? null,
          criteria,
          judgeVersion: opts.judgeVersion,
        },
        opts.judgeOptions,
      )

      results[index] = { rowId: row.id, verdict }
      if (opts.onResult) {
        await opts.onResult({ rowId: row.id, verdict })
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      const message = e instanceof JudgeError ? `${e.message} (status ${e.status})` : e.message
      results[index] = { rowId: row.id, verdict: null, error: message }
      if (opts.onResult) {
        try {
          await opts.onResult({ rowId: row.id, verdict: null, error: e })
        } catch {
          // onResult must not be able to kill the run.
        }
      }
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= rows.length) return
      await processRow(i)
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, rows.length); i++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  return { runId, results }
}
