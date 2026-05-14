/**
 * MetadataStrip — renders the `sample.metadata` map as labelled
 * key/value chips. Splits user-provided metadata (via
 * `with_gravel_metadata({...})`) from SDK-provided keys so the
 * reviewer can tell at a glance which fields came from their app
 * vs which came from the tracer.
 *
 * Known SDK keys are filtered out of the main strip — token counts
 * already live in `TokenUsageStrip`, the model already lives in the
 * sample header, and the rest is provider-internal noise. User
 * metadata under `metadata.user` (or shallow keys we don't recognise
 * as SDK-emitted) is surfaced prominently.
 */
import type { ReactNode } from 'react'

import { HumanValue } from './HumanValue'
import { humaniseKey } from '../../lib/humanise'

interface MetadataStripProps {
  metadata: Record<string, unknown> | null | undefined
}

const SDK_KEYS = new Set([
  'tokens_input',
  'tokens_output',
  'model',
  'states',
  'observations',
  'user',
  'group_id',
  'step_index',
  'duration_ms',
  'error',
])

export function MetadataStrip({ metadata }: MetadataStripProps): ReactNode {
  if (!metadata) return null

  const userMeta = isPlainObject(metadata.user) ? metadata.user : null
  const orphanUserKeys: Array<[string, unknown]> = []
  for (const [k, v] of Object.entries(metadata)) {
    if (SDK_KEYS.has(k)) continue
    orphanUserKeys.push([k, v])
  }

  const hasUser = userMeta !== null || orphanUserKeys.length > 0
  if (!hasUser) return null

  const entries: Array<[string, unknown]> = []
  if (userMeta) for (const e of Object.entries(userMeta)) entries.push(e)
  for (const e of orphanUserKeys) entries.push(e)

  return (
    <section>
      <h4 className="mb-2 text-[11px] uppercase tracking-wide text-text-muted">Metadata</h4>
      <div className="flex flex-wrap gap-2">
        {entries.map(([k, v]) => (
          <Chip key={k} label={humaniseKey(k)} value={v} />
        ))}
      </div>
    </section>
  )
}

function Chip({ label, value }: { label: string; value: unknown }): ReactNode {
  return (
    <span className="inline-flex max-w-md items-baseline gap-1.5 rounded border border-warm bg-warm/20 px-2 py-1 text-xs">
      <span className="font-medium text-text-muted">{label}</span>
      <span className="min-w-0 break-words text-text-dark">
        <HumanValue value={value} />
      </span>
    </span>
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
