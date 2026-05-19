/**
 * TokenUsageStrip — a small "X in / Y out / Z total" stat row.
 *
 * Reads a provider-shaped `usage` object via
 * `tokensFromUsage` so it can handle the four common naming
 * conventions (OpenAI Chat `prompt_tokens`/`completion_tokens`,
 * Anthropic `input_tokens`/`output_tokens`, Vercel AI v4+
 * `inputTokens`/`outputTokens`, OpenAI Responses `input_tokens`).
 * Renders nothing if no tokens are present.
 */
import type { ReactNode } from 'react'

import { tokensFromUsage } from '../../lib/humanise'

interface TokenUsageStripProps {
  usage: unknown
}

export function TokenUsageStrip({ usage }: TokenUsageStripProps): ReactNode {
  const t = tokensFromUsage(usage)
  if (!t) return null
  const parts: ReactNode[] = []
  if (t.input !== null) parts.push(<Stat key="in" label="in" value={t.input} />)
  if (t.output !== null) parts.push(<Stat key="out" label="out" value={t.output} />)
  if (t.reasoning !== null && t.reasoning > 0) {
    parts.push(<Stat key="reasoning" label="thinking" value={t.reasoning} />)
  }
  if (t.total !== null) parts.push(<Stat key="total" label="total" value={t.total} />)
  if (parts.length === 0) return null
  return (
    <div className="inline-flex items-center gap-2 text-[11px] text-text-muted">
      <span className="uppercase tracking-wide">Tokens</span>
      {parts}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <span className="inline-flex items-baseline gap-1 rounded bg-warm px-1.5 py-0.5">
      <span className="font-mono text-text-dark">{value.toLocaleString('en')}</span>
      <span className="text-[10px] uppercase">{label}</span>
    </span>
  )
}
