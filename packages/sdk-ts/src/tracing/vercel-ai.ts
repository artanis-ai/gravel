/**
 * Auto-instrumentation for the Vercel AI SDK (`ai` package).
 *
 *
 * Approach chosen: WRAP the four entrypoints (`generateText`, `streamText`,
 * `generateObject`, `streamObject`) by re-exporting through a Proxy on the
 * loaded module's exports table. This is the lowest-friction path:
 *   - Doesn't require the user to opt into `experimental_telemetry`.
 *   - Doesn't register a global OTel provider that would conflict with the
 *     user's own (avoiding the "double-counting" risk called out in spec §2).
 *   - Doesn't depend on a Vercel-internal API that may shift between minor
 *     versions; we only call the public entrypoints.
 *
 * Caveat: ESM modules are normally read-only. We mutate the loaded module's
 * function bindings via the cached require/import object. In practice this
 * works for CommonJS callers (`require('ai')`) and for ESM callers that
 * receive the namespace before subsequent imports — the user's own
 * `import { generateText } from 'ai'` is hoisted to module load, so by the
 * time their code runs they hold the wrapped binding. If a runtime hot-
 * swaps this we no-op silently.
 */
import { gravelContext } from './context.js'
import { persistSample } from './persist.js'

function isTracingDisabledEnv(): boolean {
  return process.env.GRAVEL_TRACING_DISABLED === '1'
}

const PATCHED = Symbol.for('@artanis-ai/gravel/vercel-ai-patched')

if (!isTracingDisabledEnv()) {
  void patchVercelAI()
}

async function patchVercelAI(): Promise<void> {
  let mod: any
  try {
    const id = 'ai'
    mod = await import(/* @vite-ignore */ id)
  } catch {
    return
  }
  try {
    if ((mod as any)[PATCHED]) return
  } catch {
    // Strict ESM namespace proxies (e.g. vitest mocks) throw on unknown keys;
    // fall through and rely on wrapVercelFn's idempotency guard.
  }
  try {
    Object.defineProperty(mod, PATCHED, { value: true, enumerable: false, configurable: true })
  } catch {
    // Frozen ESM namespace; the per-fn __gravelWrapped flag still keeps us
    // idempotent.
  }

  for (const name of ['generateText', 'streamText', 'generateObject', 'streamObject']) {
    wrapVercelFn(mod, name)
  }
}

function wrapVercelFn(mod: any, name: string): void {
  const original = mod?.[name]
  if (typeof original !== 'function' || (original as any).__gravelWrapped) return

  const wrapped = function gravelVercelWrapped(...args: unknown[]) {
    if (isTracingDisabledEnv() || gravelContext.isTracingDisabled()) {
      return original.apply(undefined, args)
    }
    const startedAt = new Date()
    const params = (args[0] ?? {}) as any
    const model = extractModelId(params)
    const input = sanitizeInput(params)

    let result: any
    try {
      // Suppress fetch auto-tracing — Vercel AI SDK calls provider HTTP
      // endpoints under the hood; the SDK-level trace is the canonical one.
      result = gravelContext.runWithFetchTracingDisabled(() => original.apply(undefined, args))
    } catch (err) {
      void persistSample({
        name: `vercel-ai.${name}`,
        status: 'errored',
        startedAt,
        finishedAt: new Date(),
        provider: 'vercel-ai',
        model,
        input,
        errorMessage: (err as Error).message,
      })
      throw err
    }

    return Promise.resolve(result).then(
      (response: any) => {
        // streamText/streamObject return rich objects with promises like
        // `response.text` / `response.usage`. We attach to those without
        // consuming the user-visible iterator.
        if (name === 'streamText' || name === 'streamObject') {
          attachStreamObservers(response, name, { startedAt, model, input })
          return response
        }
        const usage = response?.usage
        void persistSample({
          name: `vercel-ai.${name}`,
          status: 'completed',
          startedAt,
          finishedAt: new Date(),
          provider: 'vercel-ai',
          model: response?.response?.modelId ?? model,
          tokensInput: usage?.inputTokens,
          tokensOutput: usage?.outputTokens,
          input,
          output: extractGenerateOutput(response),
        })
        return response
      },
      (err: any) => {
        void persistSample({
          name: `vercel-ai.${name}`,
          status: 'errored',
          startedAt,
          finishedAt: new Date(),
          provider: 'vercel-ai',
          model,
          input,
          errorMessage: err?.message ?? String(err),
        })
        throw err
      },
    )
  }
  ;(wrapped as any).__gravelWrapped = true
  try {
    mod[name] = wrapped
  } catch {
    // ESM namespace is sealed; can't replace. Skip silently.
  }
}

function attachStreamObservers(
  response: any,
  name: string,
  ctx: { startedAt: Date; model?: string; input: unknown },
): void {
  // The Vercel AI SDK's stream result exposes a set of Promises (`.usage`,
  // `.text`, `.object`, `.toolCalls`, `.toolResults`, `.steps`, `.reasoning`,
  // `.reasoningText`, `.sources`, `.files`, `.warnings`, `.providerMetadata`,
  // `.finishReason`, `.content`, `.response`). Awaiting them does NOT consume
  // the user's iterator — they're independent consolidations.
  const finalize = async () => {
    try {
      const settle = async <T>(p: unknown): Promise<T | undefined> => {
        try {
          return (await Promise.resolve(p)) as T | undefined
        } catch {
          return undefined
        }
      }
      const usage = await settle<any>(response?.usage)
      const finishReason = await settle<string>(response?.finishReason)
      const toolCalls = await settle<unknown[]>(response?.toolCalls)
      const toolResults = await settle<unknown[]>(response?.toolResults)
      const steps = await settle<unknown[]>(response?.steps)
      const reasoning = await settle<unknown[]>(response?.reasoning)
      const reasoningText = await settle<string>(response?.reasoningText)
      const sources = await settle<unknown[]>(response?.sources)
      const files = await settle<unknown[]>(response?.files)
      const warnings = await settle<unknown[]>(response?.warnings)
      const providerMetadata = await settle<Record<string, unknown>>(
        response?.providerMetadata,
      )
      const content = await settle<unknown[]>(response?.content)
      const resp = await settle<any>(response?.response)
      const text =
        name === 'streamText' ? await settle<string>(response?.text) : undefined
      const object =
        name === 'streamObject' ? await settle<unknown>(response?.object) : undefined
      const output = pruneUndefined({
        text,
        object,
        content,
        finishReason,
        usage,
        toolCalls,
        toolResults,
        steps,
        reasoning,
        reasoningText,
        sources,
        files,
        warnings,
        providerMetadata,
      })
      void persistSample({
        name: `vercel-ai.${name}`,
        status: 'completed',
        startedAt: ctx.startedAt,
        finishedAt: new Date(),
        provider: 'vercel-ai',
        model: resp?.modelId ?? ctx.model,
        tokensInput: usage?.inputTokens,
        tokensOutput: usage?.outputTokens,
        input: ctx.input,
        output,
      })
    } catch (err) {
      void persistSample({
        name: `vercel-ai.${name}`,
        status: 'errored',
        startedAt: ctx.startedAt,
        finishedAt: new Date(),
        provider: 'vercel-ai',
        model: ctx.model,
        input: ctx.input,
        errorMessage: (err as Error).message,
      })
    }
  }
  void finalize()
}

function extractModelId(params: any): string | undefined {
  const m = params?.model
  if (typeof m === 'string') return m
  if (typeof m?.modelId === 'string') return m.modelId
  return undefined
}

function sanitizeInput(params: any): unknown {
  if (!params || typeof params !== 'object') return params
  // Drop the model object (it's a constructor) — we already pull the id
  // separately. Everything else (messages, prompt, system, tools, schema)
  // is plain data and useful to record.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { model, ...rest } = params
  return rest
}

function extractGenerateOutput(response: any): unknown {
  if (response == null) return response
  return pruneUndefined({
    text: response.text,
    object: response.object,
    content: response.content,
    finishReason: response.finishReason,
    usage: response.usage,
    toolCalls: response.toolCalls,
    toolResults: response.toolResults,
    steps: response.steps,
    reasoning: response.reasoning,
    reasoningText: response.reasoningText,
    sources: response.sources,
    files: response.files,
    warnings: response.warnings,
    providerMetadata: response.providerMetadata,
  })
}

function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}
