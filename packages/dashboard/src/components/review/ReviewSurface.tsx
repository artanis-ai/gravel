/**
 * ReviewSurface — the dispatch shell that wraps every per-source
 * renderer.
 *
 * Responsibilities:
 *   - Run `detectSource` on the trace `name` + payloads to pick
 *     the renderer.
 *   - Unwrap the fetch envelope so renderers always see the inner
 *     provider payload, regardless of whether it arrived via SDK
 *     or via the raw-fetch tracer.
 *   - Render the surrounding chrome the renderers don't own:
 *       - `FetchHeader` when `isFetch` is true (full width, above
 *         both panes)
 *       - `ErrorBanner` when `metadata.error` is populated (same)
 *       - Side-by-side Input / Output panes from the renderer's
 *         `{input, output}` result
 *       - `TokenUsageStrip` + source chip + `MetadataStrip` below
 *
 * The two-pane layout matches the dashboard's long-standing
 * convention: request on the left, response on the right.
 * Renderers stay focused on payload semantics — they don't reach
 * around the chrome.
 */
import type { ReactNode } from 'react'

import { detectSource, unwrapFetch } from '../../lib/source'
import { ErrorBanner } from './ErrorBanner'
import { FetchHeader } from './FetchHeader'
import { MetadataStrip } from './MetadataStrip'
import { StreamObservations } from './StreamObservations'
import { TokenUsageStrip } from './TokenUsageStrip'
import { RENDERERS } from './renderers'

interface ReviewSurfaceProps {
  name: string
  input: unknown
  output: unknown
  metadata: Record<string, unknown> | null | undefined
}

export function ReviewSurface({
  name,
  input,
  output,
  metadata,
}: ReviewSurfaceProps): ReactNode {
  const env = unwrapFetch(name, input, output)
  const source = detectSource(name, env.input, env.output)
  const Renderer = RENDERERS[source]
  const usage = extractUsage(env.output)
  const error = metadata && isPlainObject(metadata.error) ? metadata.error : null
  const { input: inputView, output: outputView } = Renderer({
    input: env.input,
    output: env.output,
    isFetch: env.isFetch,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(env.isFetch || error) && (
        <div className="space-y-2 px-4 pt-3">
          {env.isFetch && (
            <FetchHeader
              url={env.url}
              method={env.method}
              status={env.status}
              statusText={env.statusText}
            />
          )}
          {error && <ErrorBanner error={error} />}
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-px bg-warm/60 md:grid-cols-2">
        <Pane label="Input">{inputView}</Pane>
        <Pane label="Output">{outputView}</Pane>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-warm bg-warm/20 px-4 py-2">
        <div className="flex flex-wrap items-baseline gap-3">
          <TokenUsageStrip usage={usage} />
          <StreamObservations metadata={metadata} />
        </div>
        <div className="flex items-baseline gap-2">
          <RoutingPill metadata={metadata} />
          <span className="font-mono text-[11px] text-text-muted">{source}</span>
        </div>
      </div>

      {metadata && (
        <div className="border-t border-warm bg-warm/10 px-4 py-2">
          <MetadataStrip metadata={metadata} />
        </div>
      )}
    </div>
  )
}

function Pane({ label, children }: { label: string; children: ReactNode }): ReactNode {
  const empty = children === null || children === undefined
  return (
    <section className="flex min-h-0 flex-col bg-cream">
      <header className="flex shrink-0 items-baseline border-b border-warm/60 px-4 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-mid">
          {label}
        </h3>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3 text-sm text-text-dark">
        {empty ? (
          <span className="italic text-text-muted">(none)</span>
        ) : (
          children
        )}
      </div>
    </section>
  )
}

function extractUsage(output: unknown): unknown {
  if (!isPlainObject(output)) return null
  // OpenAI / Anthropic / Vercel-AI: `output.usage`.
  if (isPlainObject(output.usage)) return output.usage
  // LangChain: nested under `llm_output.token_usage`.
  if (isPlainObject(output.llm_output) && isPlainObject(output.llm_output.token_usage)) {
    return output.llm_output.token_usage
  }
  // Gemini: `usage_metadata` (Python snake_case) / `usageMetadata` (TS).
  if (isPlainObject(output.usage_metadata)) return output.usage_metadata
  if (isPlainObject(output.usageMetadata)) return output.usageMetadata
  return null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Surfaces the tracer-recorded routing backend (`metadata.routing`) as a
 * small caption. Today only Gemini calls populate this (Vertex AI vs the
 * Gemini Developer API), but the wiring is provider-agnostic so other
 * tracers can adopt the same key. Returns null when the field is absent
 * or unrecognised — the existing dashboard chrome stays identical for
 * non-routed providers.
 */
function RoutingPill({
  metadata,
}: {
  metadata: Record<string, unknown> | null | undefined
}): ReactNode {
  if (!metadata) return null
  const routing = metadata.routing
  if (typeof routing !== 'string') return null
  const label = ROUTING_LABEL[routing]
  if (!label) return null
  return (
    <span className="inline-flex items-center rounded bg-forest/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-forest">
      via {label}
    </span>
  )
}

const ROUTING_LABEL: Record<string, string> = {
  vertex: 'Vertex AI',
  enterprise: 'Gemini Enterprise',
}
