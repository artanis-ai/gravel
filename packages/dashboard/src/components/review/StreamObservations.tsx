/**
 * StreamObservations — summarises the stream chunks the SDK
 * recorded in `metadata.states` (Python) or `metadata.observations`
 * (legacy TS alias).
 *
 * The renderer above is responsible for showing the assembled
 * output prominently; this strip lives next to TokenUsageStrip
 * and gives the reviewer the streaming chrome: chunk count,
 * throughput (chunks/sec), and a collapsible disclosure of the
 * raw events. We never inline the chunk list — for long
 * generations it's a wall of JSON.
 */
import type { ReactNode } from 'react'

import { HumanValue } from './HumanValue'

interface StreamObservationsProps {
  metadata: Record<string, unknown> | null | undefined
}

export function StreamObservations({ metadata }: StreamObservationsProps): ReactNode {
  const chunks = extractChunks(metadata)
  if (!chunks || chunks.length === 0) return null

  const chunkCount = chunks.length
  const tsValues = chunks
    .map((c) => (isPlainObject(c) && typeof c.ts === 'number' ? c.ts : null))
    .filter((v): v is number => v !== null)
  const throughput = computeThroughput(tsValues, chunkCount)

  return (
    <details className="inline-flex items-baseline">
      <summary className="cursor-pointer text-[11px] text-text-muted">
        <span className="uppercase tracking-wide">Stream</span>{' '}
        <span className="font-mono">{chunkCount}</span> chunk
        {chunkCount === 1 ? '' : 's'}
        {throughput !== null && (
          <>
            {' '}
            <span className="font-mono">· {throughput.toFixed(1)}/s</span>
          </>
        )}
      </summary>
      <div className="mt-2 max-h-64 overflow-y-auto rounded border border-warm bg-cream p-2 text-xs">
        <HumanValue value={chunks} />
      </div>
    </details>
  )
}

function extractChunks(
  metadata: Record<string, unknown> | null | undefined,
): unknown[] | null {
  if (!metadata) return null
  if (Array.isArray(metadata.states)) return metadata.states
  if (Array.isArray(metadata.observations)) return metadata.observations
  return null
}

function computeThroughput(timestamps: number[], chunkCount: number): number | null {
  if (timestamps.length < 2) return null
  const min = Math.min(...timestamps)
  const max = Math.max(...timestamps)
  const durSec = (max - min) / 1000
  if (durSec <= 0) return null
  return chunkCount / durSec
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
