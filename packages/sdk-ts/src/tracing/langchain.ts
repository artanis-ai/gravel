/**
 * Auto-instrumentation for Langchain JS.
 *
 *
 * Approach: register a `BaseCallbackHandler` on the global Langchain
 * callback manager so every chain / LLM / tool invocation made through
 * Langchain primitives is captured. We do NOT monkey-patch — that's
 * against Langchain's grain.
 *
 * Implementation: `@langchain/core/callbacks/manager` exposes
 * `setGlobalCallbackHandler` (or in older versions, the user wires via
 * `LANGCHAIN_HANDLER` env). We try the modern path first; if missing we
 * silently no-op.
 *
 * Each Langchain "run" maps to one trace. Run IDs are propagated by
 * Langchain so we can dedupe with the OpenAI patch (spec §2: "The lib
 * detects this and dedupes on a Langchain-injected request ID").
 */
import { gravelContext } from './context.js'
import { persistSample } from './persist.js'

function isTracingDisabledEnv(): boolean {
  return process.env.GRAVEL_TRACING_DISABLED === '1'
}

const PATCHED = Symbol.for('@artanis-ai/gravel/langchain-patched')

if (!isTracingDisabledEnv()) {
  void patchLangchain()
}

interface RunState {
  startedAt: Date
  name: string
  input: unknown
  model?: string
  provider?: string
  /** Restorer returned by `gravelContext.pushSdkTracingDisabled()` at
   *  start; called in the matching end/error callback to revert the
   *  async-context store. Only set for LLM-shaped callbacks. */
  popSdkSuppress?: () => void
}

const activeRuns = new Map<string, RunState>()

async function patchLangchain(): Promise<void> {
  let callbacks: any
  try {
    const id = '@langchain/core/callbacks/base'
    callbacks = await import(/* @vite-ignore */ id)
  } catch {
    return
  }
  let manager: any
  try {
    const id = '@langchain/core/callbacks/manager'
    manager = await import(/* @vite-ignore */ id)
  } catch {
    return
  }
  if ((globalThis as any)[PATCHED]) return
  ;(globalThis as any)[PATCHED] = true

  const BaseCallbackHandler = callbacks.BaseCallbackHandler
  if (!BaseCallbackHandler || typeof BaseCallbackHandler !== 'function') return

  class GravelCallbackHandler extends BaseCallbackHandler {
    name = 'gravel-tracer'

    handleLLMStart(
      llm: any,
      prompts: string[],
      runId: string,
      _parentRunId?: string,
      extraParams?: Record<string, unknown>,
    ): void {
      const popSdkSuppress = gravelContext.pushSdkTracingDisabled()
      activeRuns.set(runId, {
        startedAt: new Date(),
        name: `langchain.llm.${llm?.id?.[llm.id.length - 1] ?? 'call'}`,
        input: { prompts, extraParams },
        model: extractModel(llm, extraParams),
        provider: 'langchain',
        popSdkSuppress,
      })
    }

    handleChatModelStart(
      llm: any,
      messages: unknown[],
      runId: string,
      _parentRunId?: string,
      extraParams?: Record<string, unknown>,
    ): void {
      const popSdkSuppress = gravelContext.pushSdkTracingDisabled()
      activeRuns.set(runId, {
        startedAt: new Date(),
        name: `langchain.chat.${llm?.id?.[llm.id.length - 1] ?? 'call'}`,
        input: { messages, extraParams },
        model: extractModel(llm, extraParams),
        provider: 'langchain',
        popSdkSuppress,
      })
    }

    handleLLMEnd(output: any, runId: string): void {
      const state = activeRuns.get(runId)
      if (!state) return
      activeRuns.delete(runId)
      state.popSdkSuppress?.()
      const usage = output?.llmOutput?.tokenUsage ?? output?.llmOutput?.usage
      void persistSample({
        name: state.name,
        status: 'completed',
        startedAt: state.startedAt,
        finishedAt: new Date(),
        provider: state.provider,
        model: state.model,
        tokensInput: usage?.promptTokens ?? usage?.input_tokens,
        tokensOutput: usage?.completionTokens ?? usage?.output_tokens,
        input: state.input,
        output,
      })
    }

    handleLLMError(err: Error, runId: string): void {
      const state = activeRuns.get(runId)
      if (!state) return
      activeRuns.delete(runId)
      state.popSdkSuppress?.()
      void persistSample({
        name: state.name,
        status: 'errored',
        startedAt: state.startedAt,
        finishedAt: new Date(),
        provider: state.provider,
        model: state.model,
        input: state.input,
        errorMessage: err?.message ?? String(err),
      })
    }

    handleChainStart(chain: any, inputs: unknown, runId: string): void {
      activeRuns.set(runId, {
        startedAt: new Date(),
        name: `langchain.chain.${chain?.id?.[chain.id.length - 1] ?? 'run'}`,
        input: inputs,
        provider: 'langchain',
      })
    }

    handleChainEnd(outputs: unknown, runId: string): void {
      const state = activeRuns.get(runId)
      if (!state) return
      activeRuns.delete(runId)
      void persistSample({
        name: state.name,
        status: 'completed',
        startedAt: state.startedAt,
        finishedAt: new Date(),
        provider: state.provider,
        input: state.input,
        output: outputs,
      })
    }

    handleChainError(err: Error, runId: string): void {
      const state = activeRuns.get(runId)
      if (!state) return
      activeRuns.delete(runId)
      void persistSample({
        name: state.name,
        status: 'errored',
        startedAt: state.startedAt,
        finishedAt: new Date(),
        provider: state.provider,
        input: state.input,
        errorMessage: err?.message ?? String(err),
      })
    }

    // ---- Tools ----
    // Tool invocations get their own trace row so reviewers can find
    // them in the Samples list. Mirrors the Python LC handler.
    handleToolStart(
      tool: any,
      input: string,
      runId: string,
      _parentRunId?: string,
      _tags?: string[],
      _metadata?: Record<string, unknown>,
      _runName?: string,
    ): void {
      activeRuns.set(runId, {
        startedAt: new Date(),
        name: `langchain.tool.${tool?.id?.[tool.id.length - 1] ?? tool?.name ?? 'call'}`,
        input: { input, tool: tool?.name ?? tool?.id?.join('.') },
        provider: 'langchain',
      })
    }

    handleToolEnd(output: unknown, runId: string): void {
      const state = activeRuns.get(runId)
      if (!state) return
      activeRuns.delete(runId)
      void persistSample({
        name: state.name,
        status: 'completed',
        startedAt: state.startedAt,
        finishedAt: new Date(),
        provider: state.provider,
        input: state.input,
        output: typeof output === 'string' ? { value: output } : output,
      })
    }

    handleToolError(err: Error, runId: string): void {
      const state = activeRuns.get(runId)
      if (!state) return
      activeRuns.delete(runId)
      void persistSample({
        name: state.name,
        status: 'errored',
        startedAt: state.startedAt,
        finishedAt: new Date(),
        provider: state.provider,
        input: state.input,
        errorMessage: err?.message ?? String(err),
      })
    }

    // ---- Retrievers ----
    // Each retrieval gets its own trace row so reviewers can see
    // which query produced which documents.
    handleRetrieverStart(
      retriever: any,
      query: string,
      runId: string,
      _parentRunId?: string,
      _tags?: string[],
      _metadata?: Record<string, unknown>,
      _runName?: string,
    ): void {
      activeRuns.set(runId, {
        startedAt: new Date(),
        name: `langchain.retriever.${retriever?.id?.[retriever.id.length - 1] ?? 'call'}`,
        input: { query, retriever: retriever?.id?.join('.') },
        provider: 'langchain',
      })
    }

    handleRetrieverEnd(documents: unknown, runId: string): void {
      const state = activeRuns.get(runId)
      if (!state) return
      activeRuns.delete(runId)
      const count = Array.isArray(documents) ? documents.length : null
      void persistSample({
        name: state.name,
        status: 'completed',
        startedAt: state.startedAt,
        finishedAt: new Date(),
        provider: state.provider,
        input: state.input,
        output: count !== null ? { documents, count } : documents,
      })
    }

    handleRetrieverError(err: Error, runId: string): void {
      const state = activeRuns.get(runId)
      if (!state) return
      activeRuns.delete(runId)
      void persistSample({
        name: state.name,
        status: 'errored',
        startedAt: state.startedAt,
        finishedAt: new Date(),
        provider: state.provider,
        input: state.input,
        errorMessage: err?.message ?? String(err),
      })
    }
  }

  // Honour per-call disable. The handler runs inside the user's call stack
  // so AsyncLocalStorage propagation should make this work; cheap guard.
  const handler = new GravelCallbackHandler()
  const origStart = handler.handleLLMStart.bind(handler)
  handler.handleLLMStart = (...args: any[]) => {
    if (gravelContext.isTracingDisabled()) return
    return (origStart as any)(...args)
  }
  const origChatStart = handler.handleChatModelStart.bind(handler)
  handler.handleChatModelStart = (...args: any[]) => {
    if (gravelContext.isTracingDisabled()) return
    return (origChatStart as any)(...args)
  }

  // Modern API: setGlobalCallbackHandler. Older / stripped builds may not
  // export it; we just attach via the global env-var fallback (no-op then).
  const setGlobal =
    manager.setGlobalCallbackHandler ?? manager.CallbackManager?.setGlobalHandler
  if (typeof setGlobal === 'function') {
    setGlobal(handler)
  }
}

function extractModel(llm: any, extraParams?: Record<string, unknown>): string | undefined {
  if (typeof llm?.modelName === 'string') return llm.modelName
  if (typeof llm?.model === 'string') return llm.model
  const invocation = (extraParams?.invocation_params ?? {}) as Record<string, unknown>
  if (typeof invocation.model === 'string') return invocation.model
  if (typeof invocation.modelName === 'string') return invocation.modelName as string
  return undefined
}
