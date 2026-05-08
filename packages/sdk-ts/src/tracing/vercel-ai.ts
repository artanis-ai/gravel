/**
 * Auto-instrumentation for the Vercel AI SDK (`ai` package).
 *
 * Spec: gravel-cloud/docs/spec/tracing.md §2 (Vercel AI SDK section)
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
          model,
          tokensInput: usage?.promptTokens ?? usage?.inputTokens,
          tokensOutput: usage?.completionTokens ?? usage?.outputTokens,
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
  // The Vercel AI SDK's stream result exposes a `.usage` Promise and either
  // `.text` (streamText) or `.object` (streamObject). Awaiting these does
  // NOT consume the user's iterator — they're independent consolidations.
  const finalize = async () => {
    try {
      const usage = await Promise.resolve(response?.usage).catch(() => undefined)
      const text =
        name === 'streamText'
          ? await Promise.resolve(response?.text).catch(() => undefined)
          : undefined
      const object =
        name === 'streamObject'
          ? await Promise.resolve(response?.object).catch(() => undefined)
          : undefined
      void persistSample({
        name: `vercel-ai.${name}`,
        status: 'completed',
        startedAt: ctx.startedAt,
        finishedAt: new Date(),
        provider: 'vercel-ai',
        model: ctx.model,
        tokensInput: usage?.promptTokens ?? usage?.inputTokens,
        tokensOutput: usage?.completionTokens ?? usage?.outputTokens,
        input: ctx.input,
        output: name === 'streamText' ? { text } : { object },
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
  // Pull the user-meaningful fields and avoid serializing the entire response
  // object (which can include large internal fields).
  return {
    text: response.text,
    object: response.object,
    finishReason: response.finishReason,
    usage: response.usage,
    toolCalls: response.toolCalls,
    toolResults: response.toolResults,
  }
}
