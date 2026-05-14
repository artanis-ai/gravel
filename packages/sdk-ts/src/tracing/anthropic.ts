/**
 * Auto-patch the `@anthropic-ai/sdk` Node SDK.
 *
 *
 * Patches:
 *   - `Anthropic.Messages.prototype.create` (sync + stream variant via stream:true)
 *   - `Anthropic.Messages.prototype.stream` (helper)
 *
 * Streaming: `messages.create({ stream: true })` returns an async iterable;
 * we tee. `messages.stream(...)` returns a `MessageStream` object that's
 * itself an event emitter + async iterable. We attach to its `finalMessage`
 * promise to capture the consolidated payload without consuming the stream.
 */
import { gravelContext } from './context.js'
import { persistSample } from './persist.js'

function isTracingDisabledEnv(): boolean {
  return process.env.GRAVEL_TRACING_DISABLED === '1'
}

const PATCHED = Symbol.for('@artanis-ai/gravel/anthropic-patched')

if (!isTracingDisabledEnv()) {
  void patchAnthropic()
}

async function patchAnthropic(): Promise<void> {
  let mod: any
  try {
    const id = '@anthropic-ai/sdk'
    mod = await import(/* @vite-ignore */ id)
  } catch {
    return
  }
  const Anthropic = mod.default ?? mod.Anthropic ?? mod
  if (!Anthropic || (Anthropic as any)[PATCHED]) return
  ;(Anthropic as any)[PATCHED] = true

  const Messages = Anthropic.Messages
  if (Messages?.prototype?.create) {
    wrapMessagesCreate(Messages.prototype)
  }
  if (Messages?.prototype?.stream) {
    wrapMessagesStream(Messages.prototype)
  }
}

function wrapMessagesCreate(proto: any): void {
  const original = proto.create
  if (typeof original !== 'function' || (original as any).__gravelWrapped) return

  const wrapped = function gravelAnthropicCreate(this: any, ...args: unknown[]) {
    if (isTracingDisabledEnv() || gravelContext.isTracingDisabled() || gravelContext.isSdkTracingDisabled()) {
      return original.apply(this, args)
    }
    const startedAt = new Date()
    const params = (args[0] ?? {}) as any
    const isStream = Boolean(params.stream)
    const model = params.model

    let result: any
    try {
      // Suppress fetch auto-tracing — the Anthropic SDK calls fetch under
      // the hood, and we don't want the raw-fetch patcher to record a
      // duplicate alongside this SDK-level trace.
      result = gravelContext.runWithFetchTracingDisabled(() => original.apply(this, args))
    } catch (err) {
      void persistSample({
        name: 'anthropic.messages.create',
        status: 'errored',
        startedAt,
        finishedAt: new Date(),
        provider: 'anthropic',
        model,
        input: params,
        errorMessage: (err as Error).message,
      })
      throw err
    }

    return Promise.resolve(result).then(
      (response: any) => {
        if (isStream && response && typeof response[Symbol.asyncIterator] === 'function') {
          return teeAnthropicStream(response, { startedAt, model, input: params })
        }
        const usage = response?.usage
        void persistSample({
          name: 'anthropic.messages.create',
          status: 'completed',
          startedAt,
          finishedAt: new Date(),
          provider: 'anthropic',
          model,
          tokensInput: usage?.input_tokens,
          tokensOutput: usage?.output_tokens,
          input: params,
          output: response,
        })
        return response
      },
      (err: any) => {
        void persistSample({
          name: 'anthropic.messages.create',
          status: 'errored',
          startedAt,
          finishedAt: new Date(),
          provider: 'anthropic',
          model,
          input: params,
          errorMessage: err?.message ?? String(err),
        })
        throw err
      },
    )
  }
  ;(wrapped as any).__gravelWrapped = true
  proto.create = wrapped
}

function wrapMessagesStream(proto: any): void {
  const original = proto.stream
  if (typeof original !== 'function' || (original as any).__gravelWrapped) return

  const wrapped = function gravelAnthropicStream(this: any, ...args: unknown[]) {
    if (isTracingDisabledEnv() || gravelContext.isTracingDisabled() || gravelContext.isSdkTracingDisabled()) {
      return original.apply(this, args)
    }
    const startedAt = new Date()
    const params = (args[0] ?? {}) as any
    const model = params.model

    const stream = original.apply(this, args)
    // MessageStream exposes `finalMessage()` returning the consolidated message.
    if (stream && typeof stream.finalMessage === 'function') {
      stream
        .finalMessage()
        .then((finalMsg: any) => {
          const usage = finalMsg?.usage
          void persistSample({
            name: 'anthropic.messages.stream',
            status: 'completed',
            startedAt,
            finishedAt: new Date(),
            provider: 'anthropic',
            model,
            tokensInput: usage?.input_tokens,
            tokensOutput: usage?.output_tokens,
            input: params,
            output: finalMsg,
          })
        })
        .catch((err: any) => {
          void persistSample({
            name: 'anthropic.messages.stream',
            status: 'errored',
            startedAt,
            finishedAt: new Date(),
            provider: 'anthropic',
            model,
            input: params,
            errorMessage: err?.message ?? String(err),
          })
        })
    }
    return stream
  }
  ;(wrapped as any).__gravelWrapped = true
  proto.stream = wrapped
}

function teeAnthropicStream(
  stream: any,
  ctx: { startedAt: Date; model?: string; input: unknown },
): any {
  const collected: unknown[] = []
  const originalIterator = stream[Symbol.asyncIterator].bind(stream)

  stream[Symbol.asyncIterator] = function (): AsyncIterator<unknown> {
    const inner = originalIterator()
    return {
      async next() {
        try {
          const item = await inner.next()
          if (!item.done) {
            collected.push(item.value)
          } else {
            void persistSample({
              name: 'anthropic.messages.create',
              status: 'completed',
              startedAt: ctx.startedAt,
              finishedAt: new Date(),
              provider: 'anthropic',
              model: ctx.model,
              input: ctx.input,
              output: collapseAnthropicChunks(collected),
              states: [{ key: 'stream_chunks', data: { count: collected.length } }],
            })
          }
          return item
        } catch (err) {
          void persistSample({
            name: 'anthropic.messages.create',
            status: 'errored',
            startedAt: ctx.startedAt,
            finishedAt: new Date(),
            provider: 'anthropic',
            model: ctx.model,
            input: ctx.input,
            output: collapseAnthropicChunks(collected),
            errorMessage: (err as Error).message,
          })
          throw err
        }
      },
      async return(value?: unknown) {
        if (typeof inner.return === 'function') return await inner.return(value)
        return { value, done: true }
      },
      async throw(err?: unknown) {
        if (typeof inner.throw === 'function') return await inner.throw(err)
        throw err
      },
    }
  }
  return stream
}

function collapseAnthropicChunks(chunks: unknown[]): unknown {
  let text = ''
  for (const c of chunks) {
    const ev = c as any
    if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'text_delta') {
      text += ev.delta.text ?? ''
    }
  }
  return { text, chunk_count: chunks.length }
}
