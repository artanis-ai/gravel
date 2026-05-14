/**
 * OpenAIEmbeddings — renderer for `openai.embeddings.create`.
 *
 * Embeddings calls don't have messages — the input is a string,
 * array of strings, integer-token array (pre-encoded), or array of
 * token arrays. The output is a list of `{index, embedding[]}` rows.
 *
 * The renderer pairs each input with its output vector summary
 * (`N-d vector, first values: 0.01, -0.02, …`) rather than dumping
 * the full embedding array. The reviewer never wants to see 1536
 * floats; they want to know the call shape, the input that was
 * embedded, and the vector dimensionality.
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import type { Renderer } from '../types'

export const OpenAIEmbeddingsRenderer: Renderer = ({ input, output }) => {
  const inputs = extractInputs(input)
  const rows = extractRows(output)
  const model = extractModel(input, output)
  const encoding = isPlainObject(input) && typeof input.encoding_format === 'string'
    ? input.encoding_format
    : null
  const dimensions =
    isPlainObject(input) && typeof input.dimensions === 'number' ? input.dimensions : null

  const inputPane = (
    <div className="space-y-2">
      <div className="rounded border border-warm bg-warm/10 px-3 py-2 text-xs">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {model && (
            <span>
              <span className="text-text-muted">model: </span>
              <span className="font-mono">{model}</span>
            </span>
          )}
          {encoding && (
            <span>
              <span className="text-text-muted">encoding: </span>
              <span className="font-mono">{encoding}</span>
            </span>
          )}
          {dimensions !== null && (
            <span>
              <span className="text-text-muted">dimensions: </span>
              <span className="font-mono">{dimensions}</span>
            </span>
          )}
          <span>
            <span className="text-text-muted">inputs: </span>
            <span className="font-mono">{inputs.length}</span>
          </span>
        </div>
      </div>
      <div className="space-y-1.5">
        {inputs.map((it, i) => (
          <EmbeddingInputRow key={`emb-in-${i}`} index={i} value={it} />
        ))}
      </div>
    </div>
  )

  const outputPane =
    rows.length === 0 ? null : (
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <EmbeddingOutputRow key={`emb-out-${i}`} row={row} />
        ))}
      </div>
    )

  return { input: inputPane, output: outputPane }
}

// ---- extraction ----

type InputItem =
  | { kind: 'text'; text: string }
  | { kind: 'tokens'; tokens: number[] }
  | { kind: 'other'; raw: unknown }

interface EmbeddingRow {
  index: number
  dim: number | null
  preview: number[] | null
  raw: unknown
}

function extractInputs(input: unknown): InputItem[] {
  if (!isPlainObject(input)) return []
  const raw = input.input
  if (typeof raw === 'string') return [{ kind: 'text', text: raw }]
  if (!Array.isArray(raw)) return []
  // Array of strings → batch text. Array of numbers → single
  // pre-tokenised input. Array of arrays-of-numbers → batched
  // pre-tokenised.
  if (raw.every((v) => typeof v === 'string')) {
    return (raw as string[]).map((t) => ({ kind: 'text' as const, text: t }))
  }
  if (raw.every((v) => typeof v === 'number')) {
    return [{ kind: 'tokens', tokens: raw as number[] }]
  }
  if (raw.every((v) => Array.isArray(v) && v.every((x) => typeof x === 'number'))) {
    return (raw as number[][]).map((tokens) => ({ kind: 'tokens' as const, tokens }))
  }
  return raw.map((v) => ({ kind: 'other' as const, raw: v }))
}

function extractRows(output: unknown): EmbeddingRow[] {
  if (!isPlainObject(output)) return []
  const data = output.data
  if (!Array.isArray(data)) return []
  return data.map((d, i) => {
    const index = isPlainObject(d) && typeof d.index === 'number' ? d.index : i
    const emb = isPlainObject(d) ? d.embedding : null
    if (Array.isArray(emb) && emb.every((v) => typeof v === 'number')) {
      return { index, dim: emb.length, preview: (emb as number[]).slice(0, 4), raw: d }
    }
    return { index, dim: null, preview: null, raw: d }
  })
}

function extractModel(input: unknown, output: unknown): string | null {
  if (isPlainObject(output) && typeof output.model === 'string') return output.model
  if (isPlainObject(input) && typeof input.model === 'string') return input.model
  return null
}

// ---- views ----

function EmbeddingInputRow({
  index,
  value,
}: {
  index: number
  value: InputItem
}): ReactNode {
  return (
    <div className="rounded border border-warm bg-white px-2 py-1.5 text-sm">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
        input #{index}
      </div>
      {value.kind === 'text' ? (
        <p className="whitespace-pre-wrap break-words">{value.text}</p>
      ) : value.kind === 'tokens' ? (
        <p className="text-xs text-text-muted">
          {value.tokens.length} tokens (pre-encoded)
        </p>
      ) : (
        <HumanValue value={value.raw} />
      )}
    </div>
  )
}

function EmbeddingOutputRow({ row }: { row: EmbeddingRow }): ReactNode {
  return (
    <div className="rounded border border-warm bg-white px-2 py-1.5 text-sm">
      <div className="mb-1 flex items-baseline gap-2 text-[10px] uppercase tracking-wide text-text-muted">
        <span>index #{row.index}</span>
        {row.dim !== null && <span>· {row.dim}-d vector</span>}
      </div>
      {row.preview ? (
        <p className="font-mono text-xs">
          [{row.preview.map((v) => v.toFixed(4)).join(', ')}
          {(row.dim ?? 0) > row.preview.length ? ', …' : ''}]
        </p>
      ) : (
        <HumanValue value={row.raw} />
      )}
    </div>
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
