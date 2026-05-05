/**
 * Mallet prompt-analysis client.
 *
 * Calls the control plane's `/api/analyze` proxy, which authenticates
 * the request with the customer's Gravel API key and forwards to the
 * Mallet worker. Returns structured findings (contradictions,
 * ambiguities, best-practice violations) for the supplied prompt.
 *
 * Spec: gravel-cloud/docs/spec/analysis.md.
 */

export interface AnalyzeIssue {
  /** Issue category — analyzer-defined (e.g. 'contradiction', 'ambiguity'). */
  type: string
  severity?: 'low' | 'medium' | 'high'
  message: string
  /** Optional anchor into the prompt (segment / character range). */
  range?: { start: number; end: number }
}

export interface AnalyzeUsage {
  inputTokens: number
  outputTokens: number
  /** Number of analyzer subtasks run (LLM calls). */
  tasks: number
}

export interface AnalyzeResult {
  issues: AnalyzeIssue[]
  usage: AnalyzeUsage
}

export class AnalyzeError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`analyze failed with status ${status}`)
    this.name = 'AnalyzeError'
  }
}

interface AnalyzeOptions {
  prompt: string
  apiKey?: string
  controlPlaneUrl?: string
  /** Total request timeout in ms; default 60_000 (Mallet runs LLM tasks). */
  timeoutMs?: number
}

export async function analyzePrompt(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const apiKey = opts.apiKey ?? process.env.GRAVEL_API_KEY
  if (!apiKey) {
    throw new AnalyzeError(0, 'GRAVEL_API_KEY not set')
  }
  const baseUrl =
    opts.controlPlaneUrl ?? process.env.GRAVEL_CONTROL_PLANE_URL ?? 'https://gravel.artanis.ai'

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ prompt: opts.prompt }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    if (!res.ok) {
      throw new AnalyzeError(res.status, parsed)
    }
    return parsed as AnalyzeResult
  } catch (err) {
    if (err instanceof AnalyzeError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AnalyzeError(0, 'request timed out')
    }
    throw new AnalyzeError(0, err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(t)
  }
}
