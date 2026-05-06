/**
 * Auto-patch the `openai` Node SDK.
 *
 * Spec: gravel-cloud/docs/spec/tracing.md §2 (OpenAI section)
 *
 * Patches:
 *   - `OpenAI.Chat.Completions.prototype.create`
 *   - `OpenAI.Responses.prototype.create` (Responses API; some SDK builds expose it)
 *   - `OpenAI.Embeddings.prototype.create`
 *
 * Strategy: monkey-patch the prototype methods on the SDK's resource classes
 * once at import time. Every `new OpenAI()` instance picks up the patch.
 *
 * Streaming: `chat.completions.create` with `stream: true` returns an async
 * iterable. We tee it — wrap the original AsyncIterator so the user still
 * iterates raw chunks, while we accumulate a summary observation in parallel.
 *
 * Errors: caught, persisted with status='errored', then re-thrown.
 */
import { gravelContext } from './context.js'
import { persistTrace } from './persist.js'

function isTracingDisabledEnv(): boolean {
  return process.env.GRAVEL_TRACING_DISABLED === '1'
}

// Keep idempotent in case the user (or a test) imports twice.
const PATCHED = Symbol.for('@artanis-ai/gravel/openai-patched')

if (!isTracingDisabledEnv()) {
  void patchOpenAI()
}

async function patchOpenAI(): Promise<void> {
  let mod: any
  try {
    // Variable specifier so TS doesn't require the optional peer dep at type-check time.
    const id = 'openai'
    mod = await import(/* @vite-ignore */ id)
  } catch {
    // Not installed; nothing to patch. Spec §1: detection silently skips.
    return
  }
  const OpenAI = mod.default ?? mod.OpenAI ?? mod
  if (!OpenAI || (OpenAI as any)[PATCHED]) return
  ;(OpenAI as any)[PATCHED] = true

  // chat.completions.create
  try {
    const Completions = resolveClass(OpenAI, ['Chat', 'Completions'])
    if (Completions?.prototype?.create) {
      wrapCreate(Completions.prototype, 'create', {
        name: 'openai.chat.completions.create',
        provider: 'openai',
        extractInput: (args) => args[0],
        extractModel: (args) => (args[0] as any)?.model,
        isStreamRequest: (args) => Boolean((args[0] as any)?.stream),
      })
    }
  } catch {
    /* class shape changed; skip */
  }

  // responses.create (newer Responses API)
  try {
    const Responses = resolveClass(OpenAI, ['Responses'])
    if (Responses?.prototype?.create) {
      wrapCreate(Responses.prototype, 'create', {
        name: 'openai.responses.create',
        provider: 'openai',
        extractInput: (args) => args[0],
        extractModel: (args) => (args[0] as any)?.model,
        isStreamRequest: (args) => Boolean((args[0] as any)?.stream),
      })
    }
  } catch {
    /* not present in this SDK build */
  }

  // embeddings.create
  try {
    const Embeddings = resolveClass(OpenAI, ['Embeddings'])
    if (Embeddings?.prototype?.create) {
      wrapCreate(Embeddings.prototype, 'create', {
        name: 'openai.embeddings.create',
        provider: 'openai',
        extractInput: (args) => args[0],
        extractModel: (args) => (args[0] as any)?.model,
        isStreamRequest: () => false,
      })
    }
  } catch {
    /* skip */
  }
}

/**
 * Walk class properties to find a nested resource class. The OpenAI SDK
 * exposes resource constructors directly on the top-level constructor
 * (e.g. `OpenAI.Chat`, `OpenAI.Chat.Completions`).
 */
function resolveClass(root: any, path: string[]): any | null {
  let cur = root
  for (const segment of path) {
    if (!cur) return null
    cur = cur[segment]
  }
  return cur ?? null
}

interface WrapOptions {
  name: string
  provider: string
  extractInput: (args: unknown[]) => unknown
  extractModel: (args: unknown[]) => string | undefined
  isStreamRequest: (args: unknown[]) => boolean
}

function wrapCreate(proto: any, methodName: string, opts: WrapOptions): void {
  const original = proto[methodName]
  if (typeof original !== 'function') return
  if ((original as any).__gravelWrapped) return

  const wrapped = function gravelOpenAIWrapped(this: any, ...args: unknown[]) {
    if (isTracingDisabledEnv() || gravelContext.isTracingDisabled()) {
      return original.apply(this, args)
    }
    const startedAt = new Date()
    const isStream = opts.isStreamRequest(args)
    const model = opts.extractModel(args)
    const input = opts.extractInput(args)

    let result: any
    try {
      // Suppress fetch auto-tracing for the duration of the SDK call so
      // the underlying fetch (the OpenAI SDK uses native fetch under the
      // hood) doesn't record a duplicate trace alongside the SDK-level one.
      result = gravelContext.runWithFetchTracingDisabled(() => original.apply(this, args))
    } catch (err) {
      // Sync throw (rare for the OpenAI SDK; defensive).
      void persistTrace({
        name: opts.name,
        status: 'errored',
        startedAt,
        finishedAt: new Date(),
        provider: opts.provider,
        model,
        input,
        errorMessage: (err as Error).message,
      })
      throw err
    }

    // The OpenAI SDK returns an APIPromise that's both thenable and exposes
    // helpers. We wrap with .then() so we don't strip those helpers off the
    // returned object — but since our wrapped fn returns a plain Promise it
    // means callers that depend on `.withResponse()` etc. lose it. Trade-off
    // documented in spec §6: "Patch overhead per call ≤ 1 ms".
    return Promise.resolve(result).then(
      (response: any) => {
        if (isStream && response && typeof response[Symbol.asyncIterator] === 'function') {
          return teeStream(response, { ...opts, startedAt, model, input })
        }
        const usage = response?.usage
        void persistTrace({
          name: opts.name,
          status: 'completed',
          startedAt,
          finishedAt: new Date(),
          provider: opts.provider,
          model,
          tokensInput: usage?.prompt_tokens ?? usage?.input_tokens,
          tokensOutput: usage?.completion_tokens ?? usage?.output_tokens,
          input,
          output: response,
        })
        return response
      },
      (err: any) => {
        void persistTrace({
          name: opts.name,
          status: 'errored',
          startedAt,
          finishedAt: new Date(),
          provider: opts.provider,
          model,
          input,
          errorMessage: err?.message ?? String(err),
        })
        throw err
      },
    )
  }
  ;(wrapped as any).__gravelWrapped = true
  proto[methodName] = wrapped
}

interface TeeContext extends WrapOptions {
  startedAt: Date
  model?: string
  input: unknown
}

/**
 * Wrap a streaming response so the user iterates the original chunks while
 * we collect them in parallel. Produces a single observation summary on
 * stream close. We do NOT consume the stream ourselves first (spec
 * constraint: "must not consume the stream the user passes through").
 */
function teeStream(stream: any, ctx: TeeContext): any {
  const collectedChunks: unknown[] = []
  const originalIterator = stream[Symbol.asyncIterator].bind(stream)

  stream[Symbol.asyncIterator] = function (): AsyncIterator<unknown> {
    const inner = originalIterator()
    return {
      async next() {
        try {
          const item = await inner.next()
          if (!item.done) {
            collectedChunks.push(item.value)
          } else {
            void persistTrace({
              name: ctx.name,
              status: 'completed',
              startedAt: ctx.startedAt,
              finishedAt: new Date(),
              provider: ctx.provider,
              model: ctx.model,
              input: ctx.input,
              output: collapseChunks(collectedChunks),
              states: [{ key: 'stream_chunks', data: { count: collectedChunks.length } }],
            })
          }
          return item
        } catch (err) {
          void persistTrace({
            name: ctx.name,
            status: 'errored',
            startedAt: ctx.startedAt,
            finishedAt: new Date(),
            provider: ctx.provider,
            model: ctx.model,
            input: ctx.input,
            output: collapseChunks(collectedChunks),
            errorMessage: (err as Error).message,
          })
          throw err
        }
      },
      async return(value?: unknown) {
        if (typeof inner.return === 'function') {
          return await inner.return(value)
        }
        return { value, done: true }
      },
      async throw(err?: unknown) {
        if (typeof inner.throw === 'function') {
          return await inner.throw(err)
        }
        throw err
      },
    }
  }
  return stream
}

/**
 * Collapse a list of streaming chunks into a single textual response. Per
 * spec §2: "intermediate streaming chunks (collapsed to one observation,
 * not one per token)". Best-effort across chat.completions and responses.
 */
function collapseChunks(chunks: unknown[]): unknown {
  let text = ''
  for (const c of chunks) {
    const choice = (c as any)?.choices?.[0]
    const delta = choice?.delta?.content ?? choice?.text ?? (c as any)?.delta?.text
    if (typeof delta === 'string') text += delta
  }
  return { text, chunk_count: chunks.length }
}
