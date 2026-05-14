/**
 * LangchainTool — renderer for `langchain.tool` (Python) and
 * `langchain.tool.<runnable-id>` (TS).
 *
 * Captured by the SDK's LC callback handler when an agent / chain
 * invokes a tool. Persisted as its own trace row so the reviewer
 * can audit which arguments the agent passed and what the tool
 * returned without digging into the parent chain's state log.
 *
 * Input shape:
 *   - `input_str | input` — the (often-stringified) tool argument
 *   - `serialized` — LC's dump of the tool definition
 *   - `tool` — the tool name
 *   - `parent_run_id?` — links back to the parent chain/agent
 *
 * Output shape:
 *   - `{value}` wrapping whatever the tool returned (string / dict /
 *     list of docs)
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import { tryParseStructuredString } from '../../../lib/parseStructured'
import type { Renderer } from '../types'

export const LangchainToolRenderer: Renderer = ({ input, output }) => {
  const toolName = extractToolName(input)
  const args = extractArgs(input)
  const serialized = extractSerialized(input)
  const parentRunId = isPlainObject(input) && typeof input.parent_run_id === 'string'
    ? input.parent_run_id
    : null

  const inputPane = (
    <div className="space-y-2">
      <div className="rounded border border-forest/30 bg-forest/5 p-3 text-xs">
        <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
          <span className="inline-flex items-center rounded bg-forest/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-forest">
            Tool
          </span>
          {toolName && (
            <span className="font-mono text-[11px] font-medium">{toolName}</span>
          )}
          {parentRunId && (
            <span className="font-mono text-[10px] text-text-muted">parent: {parentRunId}</span>
          )}
        </div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
          Arguments
        </div>
        <HumanValue value={args} />
      </div>
      {serialized !== null ? (
        <div className="rounded border border-warm bg-warm/10 p-3 text-xs">
          <h5 className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">
            Tool definition
          </h5>
          <HumanValue value={serialized} />
        </div>
      ) : null}
    </div>
  )

  const outputPane = renderResult(output)
  return { input: inputPane, output: outputPane }
}

function extractToolName(input: unknown): string | null {
  if (!isPlainObject(input)) return null
  if (typeof input.tool === 'string') return input.tool
  if (typeof input.name === 'string') return input.name
  const serialized = input.serialized
  if (isPlainObject(serialized) && isPlainObject(serialized.kwargs)) {
    const name = serialized.kwargs.name
    if (typeof name === 'string') return name
  }
  return null
}

function extractArgs(input: unknown): unknown {
  if (!isPlainObject(input)) return input
  // Prefer the structured `input` field (LC's `inputs: dict` kwarg
  // when present). Fall back to `input_str` (the Python repr) which
  // the parser will then JSON/Python-repr-decode for us.
  if ('input' in input && input.input !== null && input.input !== undefined) {
    return parseJsonString(input.input)
  }
  if ('input_str' in input) return parseJsonString(input.input_str)
  if ('arguments' in input) return parseJsonString(input.arguments)
  return null
}

function extractSerialized(input: unknown): unknown {
  if (!isPlainObject(input)) return null
  if ('serialized' in input && input.serialized !== null && input.serialized !== undefined) {
    return input.serialized
  }
  return null
}

function renderResult(output: unknown): ReactNode {
  if (output === null || output === undefined) return null
  if (isPlainObject(output) && 'value' in output && Object.keys(output).length === 1) {
    // The SDK wraps a bare tool return value as `{value: ...}` so the
    // persisted output is always an object. Unwrap before rendering.
    const parsed = parseJsonString(output.value)
    return (
      <div className="rounded border border-warm bg-warm/30 p-3 text-xs">
        <div className="mb-1 flex flex-wrap items-baseline gap-2">
          <span className="inline-flex items-center rounded bg-warm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-dark">
            Tool result
          </span>
        </div>
        <HumanValue value={parsed} />
      </div>
    )
  }
  return (
    <div className="rounded border border-warm bg-warm/30 p-3 text-xs">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-warm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-dark">
          Tool result
        </span>
      </div>
      <HumanValue value={output} />
    </div>
  )
}

function parseJsonString(v: unknown): unknown {
  // LangChain Python tool callbacks hand us `input_str = str(kwargs_dict)`,
  // which is a Python repr (single quotes, `True/False/None`) rather than
  // JSON. The shared parser handles both shapes.
  return tryParseStructuredString(v)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
