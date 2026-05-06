/**
 * Auto-patch raw `globalThis.fetch` for OpenAI- and Anthropic-shaped
 * HTTP calls. Catches projects that bypass the SDKs and POST directly
 * (e.g. minimal Node services that just want one HTTP roundtrip).
 *
 * Detection is path-based:
 *   - `…/chat/completions`          → openai chat completions
 *   - `…/responses`                 → openai responses
 *   - `…/embeddings`                → openai embeddings
 *   - `…/v1/messages`               → anthropic messages
 *
 * Spec note: this is a pragmatic addition on top of the SDK auto-patches.
 * Tracing scope, error semantics, and persist plumbing match the existing
 * provider patches (tracing.md §1, §6).
 */
import { gravelContext } from './context.js'
import { persistTrace } from './persist.js'

function isTracingDisabledEnv(): boolean {
  return process.env.GRAVEL_TRACING_DISABLED === '1'
}

const PATCHED = Symbol.for('@artanis-ai/gravel/fetch-patched')

if (!isTracingDisabledEnv()) {
  patchGlobalFetch()
}

interface ProviderShape {
  provider: 'openai' | 'anthropic'
  name: string // logical trace name, e.g. "fetch:openai.chat.completions"
}

function classifyUrl(url: string): ProviderShape | null {
  // Path-based: works for both api.openai.com and OpenAI-compatible
  // proxies (Azure, vLLM, mock servers, etc.) that mirror the path.
  if (/\/chat\/completions(\?|$)/.test(url)) {
    return { provider: 'openai', name: 'fetch:openai.chat.completions' }
  }
  if (/\/responses(\?|$)/.test(url) && /api\.openai\.com|\/v1\//.test(url)) {
    return { provider: 'openai', name: 'fetch:openai.responses' }
  }
  if (/\/embeddings(\?|$)/.test(url)) {
    return { provider: 'openai', name: 'fetch:openai.embeddings' }
  }
  if (/\/v1\/messages(\?|$)/.test(url) || /api\.anthropic\.com.*\/messages/.test(url)) {
    return { provider: 'anthropic', name: 'fetch:anthropic.messages' }
  }
  return null
}

function getUrl(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    if ('url' in input && typeof (input as Request).url === 'string') return (input as Request).url
    if ('href' in input && typeof (input as URL).href === 'string') return (input as URL).href
  }
  return ''
}

function getMethod(input: unknown, init: RequestInit | undefined): string {
  if (init?.method) return init.method.toUpperCase()
  if (input && typeof input === 'object' && 'method' in input) {
    const m = (input as Request).method
    if (typeof m === 'string') return m.toUpperCase()
  }
  return 'GET'
}

async function readBody(init: RequestInit | undefined): Promise<unknown> {
  if (!init || init.body === undefined || init.body === null) return undefined
  const body = init.body as BodyInit
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries())
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return '<binary>'
  }
  // ReadableStream / Blob / FormData — too fiddly to read non-destructively.
  return '<unreadable-body>'
}

interface ParsedResponse {
  parsed?: unknown
  model?: string
  tokensInput?: number
  tokensOutput?: number
}

function parseProviderResponse(provider: 'openai' | 'anthropic', body: unknown): ParsedResponse {
  if (!body || typeof body !== 'object') return {}
  const b = body as Record<string, any>
  if (provider === 'openai') {
    return {
      parsed: body,
      model: typeof b.model === 'string' ? b.model : undefined,
      tokensInput: b.usage?.prompt_tokens ?? b.usage?.input_tokens,
      tokensOutput: b.usage?.completion_tokens ?? b.usage?.output_tokens,
    }
  }
  return {
    parsed: body,
    model: typeof b.model === 'string' ? b.model : undefined,
    tokensInput: b.usage?.input_tokens,
    tokensOutput: b.usage?.output_tokens,
  }
}

function patchGlobalFetch(): void {
  const g = globalThis as { fetch?: typeof fetch; [k: string | symbol]: unknown }
  if (!g.fetch || (g as Record<symbol, unknown>)[PATCHED]) return
  const original = g.fetch
  ;(g as Record<symbol, unknown>)[PATCHED] = true

  const patched: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = getUrl(input)
    const shape = classifyUrl(url)
    if (!shape || gravelContext.isTracingDisabled() || gravelContext.isFetchTracingDisabled()) {
      return await original(input as RequestInfo | URL, init)
    }

    const startedAt = new Date()
    const requestBody = await readBody(init)
    const method = getMethod(input, init)

    let response: Response | undefined
    let errorMessage: string | undefined
    try {
      response = await original(input as RequestInfo | URL, init)
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    // Capture the response body without consuming it from the caller. We
    // clone before reading so the user still gets a usable Response.
    let parsedResponse: ParsedResponse = {}
    if (response) {
      try {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          const cloned = response.clone()
          const json = await cloned.json()
          parsedResponse = parseProviderResponse(shape.provider, json)
        }
      } catch {
        // Don't break the user's call if response parsing fails.
      }
    }

    const finishedAt = new Date()
    void persistTrace({
      name: shape.name,
      provider: shape.provider,
      status: errorMessage || (response && !response.ok) ? 'errored' : 'completed',
      startedAt,
      finishedAt,
      input: { url, method, body: requestBody },
      output: parsedResponse.parsed ?? (response ? { status: response.status, statusText: response.statusText } : undefined),
      ...(parsedResponse.model !== undefined ? { model: parsedResponse.model } : {}),
      ...(parsedResponse.tokensInput !== undefined ? { tokensInput: parsedResponse.tokensInput } : {}),
      ...(parsedResponse.tokensOutput !== undefined ? { tokensOutput: parsedResponse.tokensOutput } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    })

    if (errorMessage && !response) {
      throw new Error(errorMessage)
    }
    return response!
  }

  g.fetch = patched
}
