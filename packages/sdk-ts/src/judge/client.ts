/**
 * Judge client: HTTP shim around the Gravel control-plane judge endpoint.
 *
 * Endpoint: POST {GRAVEL_CONTROL_PLANE_URL}/api/judge
 * Auth:     Authorization: Bearer ${GRAVEL_API_KEY}
 *
 * The control plane validates the body with a Zod schema (see gravel-cloud
 * /apps/control-plane/src/routes/judge.ts). We translate the camelCase JS
 * surface into the snake_case wire format here.
 *
 * Spec: gravel-cloud/docs/spec/api-surface.md §6 — judge.
 */

export type JudgeType = 'trace' | 'live'

export interface VerdictBreakdownEntry {
  score: number
  reasoning: string
}

export interface Verdict {
  score: number
  passed: boolean
  reasoning: string
  breakdown: Record<string, VerdictBreakdownEntry>
}

export interface JudgeCallInput {
  type: JudgeType
  input: unknown
  output: unknown
  expectedCorrection: string | null
  promptContext?: string | null
  criteria: string[]
  judgeVersion?: string
}

export interface JudgeCallOptions {
  /** Override the API key (otherwise read from env). */
  apiKey?: string
  /** Override the project id (otherwise read from env). */
  projectId?: string
  /** Override the control-plane URL (otherwise read from env / default). */
  controlPlaneUrl?: string
  /** Request timeout in ms. Default 30_000. */
  timeoutMs?: number
  /** Override fetch (for tests / custom transports). */
  fetch?: typeof fetch
}

export interface JudgeApiResponse {
  verdict: Verdict
  judge_version: string
  tokens: { input: number; output: number }
}

const DEFAULT_CONTROL_PLANE_URL = 'https://gravel.artanis.ai'
const DEFAULT_TIMEOUT_MS = 30_000

export class JudgeError extends Error {
  override readonly name = 'JudgeError'
  readonly status: number
  readonly body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

function readEnv(name: string): string | undefined {
  // Guarded for non-Node environments (Vite etc.).
  if (typeof process === 'undefined' || !process.env) return undefined
  return process.env[name]
}

function resolveCreds(opts?: JudgeCallOptions): {
  apiKey: string
  projectId: string
  baseUrl: string
} {
  const apiKey = opts?.apiKey ?? readEnv('GRAVEL_API_KEY')
  if (!apiKey) {
    throw new JudgeError(
      'Missing GRAVEL_API_KEY. Set the env var or pass options.apiKey to judgeCall().',
      0,
      null,
    )
  }
  const projectId = opts?.projectId ?? readEnv('GRAVEL_PROJECT_ID')
  if (!projectId) {
    throw new JudgeError(
      'Missing GRAVEL_PROJECT_ID. Set the env var or pass options.projectId to judgeCall().',
      0,
      null,
    )
  }
  const baseUrl =
    opts?.controlPlaneUrl ?? readEnv('GRAVEL_CONTROL_PLANE_URL') ?? DEFAULT_CONTROL_PLANE_URL
  return { apiKey, projectId, baseUrl: baseUrl.replace(/\/$/, '') }
}

/**
 * Call the control-plane judge endpoint with a single (input, output, criteria)
 * triple and return the verdict.
 *
 * Throws {@link JudgeError} on non-2xx responses, missing creds, or timeout.
 */
export async function judgeCall(
  input: JudgeCallInput,
  opts?: JudgeCallOptions,
): Promise<Verdict> {
  const { apiKey, projectId, baseUrl } = resolveCreds(opts)
  const fetchImpl = opts?.fetch ?? fetch
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const body = {
    project_id: projectId,
    type: input.type,
    input: input.input,
    output: input.output,
    expected_correction: input.expectedCorrection,
    prompt_context: input.promptContext ?? null,
    criteria: input.criteria,
    judge_version: input.judgeVersion ?? 'auto',
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/api/judge`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if ((err as Error).name === 'AbortError') {
      throw new JudgeError(`Judge request timed out after ${timeoutMs}ms`, 0, null)
    }
    throw new JudgeError(
      `Judge request failed: ${(err as Error).message}`,
      0,
      null,
    )
  }
  clearTimeout(timer)

  let parsed: unknown
  const text = await res.text()
  try {
    parsed = text.length ? JSON.parse(text) : null
  } catch {
    parsed = text
  }

  if (!res.ok) {
    const message =
      (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
        ? parsed.error
        : `Judge request failed with status ${res.status}`) as string
    throw new JudgeError(message, res.status, parsed)
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('verdict' in parsed) ||
    typeof parsed.verdict !== 'object' ||
    parsed.verdict === null
  ) {
    throw new JudgeError('Judge response missing verdict', res.status, parsed)
  }

  return (parsed as JudgeApiResponse).verdict
}
