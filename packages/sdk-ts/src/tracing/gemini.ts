/**
 * Auto-patch the `@google/genai` Node SDK (Gemini).
 *
 * Patches:
 *   - `Models.prototype.generateContent`
 *   - `Models.prototype.generateContentStream`
 *
 * The `@google/genai` package exports a `GoogleGenAI` constructor; `new
 * GoogleGenAI({apiKey: ...}).models` is an instance of the `Models` class.
 * We patch the prototype methods once at import time; every new client
 * picks up the patch. Mirrors `openai.ts` exactly.
 *
 * Streaming: `generateContentStream` returns an `AsyncIterable` of
 * `GenerateContentResponse` chunks. We tee it — wrap the original
 * AsyncIterator so the user still iterates raw chunks, while we
 * accumulate a summary observation in parallel.
 *
 * Errors: caught, persisted with status='errored', then re-thrown.
 */
import { gravelContext } from './context.js'
import { persistSample } from './persist.js'

function isTracingDisabledEnv(): boolean {
  return process.env.GRAVEL_TRACING_DISABLED === '1'
}

const PATCHED = Symbol.for('@artanis-ai/gravel/gemini-patched')

if (!isTracingDisabledEnv()) {
  void patchGemini()
}

async function patchGemini(): Promise<void> {
  let mod: any
  try {
    const id = '@google/genai'
    mod = await import(/* @vite-ignore */ id)
  } catch {
    return
  }
  // The SDK exports `GoogleGenAI` plus the resource classes (`Models`) at the
  // package root. We need the `Models` constructor to walk its prototype.
  const Models = resolveModelsClass(mod)
  if (!Models || (Models as any)[PATCHED]) return
  ;(Models as any)[PATCHED] = true

  // @google/genai assigns the public `generateContent` / `generateContentStream`
  // as own properties on the instance (auto-bound arrow functions that delegate
  // to `*Internal` on the prototype). The own-property assignment means
  // `Models.prototype.generateContent` is `undefined`. We instead wrap the
  // prototype-level `*Internal` methods — they're what the public methods
  // ultimately invoke — and report the public canonical name to the trace.
  if (Models.prototype?.generateContentInternal) {
    wrapCall(Models.prototype, 'generateContentInternal', {
      name: 'gemini.models.generate_content',
      provider: 'gemini',
      isStream: false,
    })
  }
  if (Models.prototype?.generateContentStreamInternal) {
    wrapCall(Models.prototype, 'generateContentStreamInternal', {
      name: 'gemini.models.generate_content_stream',
      provider: 'gemini',
      isStream: true,
    })
  }
}

/**
 * Resolve the `Models` class from the SDK module. The SDK ships it as a
 * top-level export, but the exact name has wobbled across releases. Try a
 * few of the known shapes before giving up. */
function resolveModelsClass(mod: any): any | null {
  if (!mod) return null
  if (typeof mod.Models === 'function') return mod.Models
  if (typeof mod.default?.Models === 'function') return mod.default.Models
  // Fallback: instantiate a throwaway client and grab the `models` resource's
  // constructor. This only fires if neither named export was found, and is
  // cheap (no API call).
  try {
    const GoogleGenAI = mod.GoogleGenAI ?? mod.default?.GoogleGenAI ?? mod.default
    if (typeof GoogleGenAI === 'function') {
      const inst = new GoogleGenAI({ apiKey: '__gravel_probe__' })
      const ctor = inst?.models?.constructor
      if (typeof ctor === 'function') return ctor
    }
  } catch {
    /* SDK may require real credentials at construction; give up silently. */
  }
  return null
}

interface WrapOptions {
  name: string
  provider: string
  isStream: boolean
}

function wrapCall(proto: any, methodName: string, opts: WrapOptions): void {
  const original = proto[methodName]
  if (typeof original !== 'function') return
  if ((original as any).__gravelWrapped) return

  const wrapped = function gravelGeminiWrapped(this: any, ...args: unknown[]) {
    if (
      isTracingDisabledEnv() ||
      gravelContext.isTracingDisabled() ||
      gravelContext.isSdkTracingDisabled()
    ) {
      return original.apply(this, args)
    }
    const startedAt = new Date()
    const req = (args[0] ?? {}) as Record<string, unknown>
    const model = typeof req.model === 'string' ? req.model : undefined
    const input = req

    let result: any
    try {
      // Suppress fetch auto-tracing for the duration of the SDK call —
      // google-genai uses native fetch under the hood; the fetch_patch
      // would otherwise record a duplicate trace.
      result = gravelContext.runWithFetchTracingDisabled(() => original.apply(this, args))
    } catch (err) {
      void persistSample({
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

    return Promise.resolve(result).then(
      (response: any) => {
        if (opts.isStream && response && typeof response[Symbol.asyncIterator] === 'function') {
          return teeStream(response, { ...opts, startedAt, model, input })
        }
        const usage = response?.usageMetadata ?? response?.usage_metadata
        void persistSample({
          name: opts.name,
          status: 'completed',
          startedAt,
          finishedAt: new Date(),
          provider: opts.provider,
          model,
          tokensInput: usage?.promptTokenCount ?? usage?.prompt_token_count,
          tokensOutput: usage?.candidatesTokenCount ?? usage?.candidates_token_count,
          input,
          output: response,
        })
        return response
      },
      (err: any) => {
        void persistSample({
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
            void persistSample({
              name: ctx.name,
              status: 'completed',
              startedAt: ctx.startedAt,
              finishedAt: new Date(),
              provider: ctx.provider,
              model: ctx.model,
              input: ctx.input,
              output: collapseChunks(collectedChunks),
              states: [
                { key: 'stream_chunks', data: { count: collectedChunks.length } },
              ],
            })
          }
          return item
        } catch (err) {
          void persistSample({
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
 * Collapse a list of Gemini stream chunks into a single text + chunk_count.
 * Best-effort: walk each chunk's candidates[].content.parts[].text. */
function collapseChunks(chunks: unknown[]): unknown {
  let text = ''
  for (const c of chunks) {
    const cand = (c as any)?.candidates?.[0]
    const parts = cand?.content?.parts
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (typeof p?.text === 'string') text += p.text
      }
    }
  }
  return { text, chunk_count: chunks.length }
}
