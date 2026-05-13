/**
 * Async-context propagation for tracing metadata + per-call disable.
 *
 *
 * The auto-patches consult this context when emitting traces. If the user
 * never imports any of these helpers, behaviour is identical to "no metadata,
 * tracing on".
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface ContextState {
  metadata: Record<string, unknown>
  tracingDisabled: boolean
  /**
   * When set, the raw-fetch auto-patch skips the call. Used by the SDK
   * patches (openai, anthropic, etc.) to mark "I already record this
   * call's trace at the SDK level" so the underlying fetch doesn't get
   * double-traced.
   */
  fetchTracingDisabled: boolean
}

const storage = new AsyncLocalStorage<ContextState>()

function currentState(): ContextState {
  return storage.getStore() ?? { metadata: {}, tracingDisabled: false, fetchTracingDisabled: false }
}

export const gravelContext = {
  /**
   * Run `fn` with the given metadata merged into trace context. The metadata
   * lands on `gravel_traces.metadata` for any traces emitted within `fn`.
   */
  run<T>(metadata: Record<string, unknown>, fn: () => T): T {
    const previous = currentState()
    return storage.run(
      { ...previous, metadata: { ...previous.metadata, ...metadata } },
      fn,
    )
  },
  /** Internal — used by SDK patches to suppress fetch double-tracing. */
  runWithFetchTracingDisabled<T>(fn: () => T): T {
    const previous = currentState()
    return storage.run({ ...previous, fetchTracingDisabled: true }, fn)
  },
  getMetadata(): Record<string, unknown> {
    return currentState().metadata
  },
  isTracingDisabled(): boolean {
    return currentState().tracingDisabled
  },
  isFetchTracingDisabled(): boolean {
    return currentState().fetchTracingDisabled
  },
}

/**
 * Tag a single LLM call with metadata. Convenient when you want to enrich
 * one call without introducing a request-scoped middleware.
 */
export async function withGravelMetadata<T>(
  metadata: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  return await Promise.resolve(gravelContext.run(metadata, fn))
}

/**
 * Disable tracing for the duration of `fn`. Useful for internal evals or
 * pipelines you don't want recursively traced.
 */
export async function withTracingDisabled<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = currentState()
  return await Promise.resolve(
    storage.run({ ...previous, tracingDisabled: true }, fn),
  )
}
