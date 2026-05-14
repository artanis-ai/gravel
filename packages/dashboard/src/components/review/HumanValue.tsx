/**
 * HumanValue — the recursive, human-friendly fallback renderer.
 *
 * Every persisted sample column eventually flows through this
 * component. The strict rule: this NEVER renders a raw JSON dump.
 * Unknown shapes always come out as labelled key-value rows,
 * tables, or lists — readable at a glance, recursively explorable.
 *
 * Where a payload field has a known interpretation (chat messages,
 * tool calls, citations, etc.), the per-source renderer pulls it
 * out and renders it with a dedicated component, then delegates
 * the leftovers back to `HumanValue` so nothing is silently lost.
 *
 * Phase-2 scope: primitives, key-value tables for objects, bullet
 * lists for arrays, columnar tables for arrays of same-shape
 * objects, and the common heuristics from `lib/humanise`
 * (URL linkification, image data-URI preview, base64 truncation,
 * very-long-string expansion). Provider-specific rendering lives
 * in the per-source renderers (Phase 3+).
 */
import { useState, type ReactNode } from 'react'

import {
  approxByteLength,
  dataUriKind,
  formatBytes,
  humaniseKey,
  looksLikeBase64,
  looksLikeUrl,
} from '../../lib/humanise'
import { ClickableImage } from './ClickableMedia'

interface HumanValueProps {
  value: unknown
  /** Maximum nesting depth before rendering the value as collapsed
   *  by default. Defaults to 4 for top-level calls. */
  depth?: number
}

const MAX_RECURSION = 12
const COLLAPSE_DEFAULT_DEPTH = 4
const LONG_STRING_THRESHOLD = 280

export function HumanValue({ value, depth = 0 }: HumanValueProps): ReactNode {
  if (depth > MAX_RECURSION) {
    return <span className="text-text-muted italic">(too deep)</span>
  }

  if (value === null || value === undefined) {
    return <span className="text-text-muted">—</span>
  }

  if (typeof value === 'string') return <HumanString value={value} />
  if (typeof value === 'number') return <HumanNumber value={value} />
  if (typeof value === 'boolean') return <HumanBoolean value={value} />
  if (typeof value === 'bigint') return <HumanNumber value={Number(value)} />

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return <HumanArray items={value} depth={depth} />
    }
    return <HumanObject obj={value as Record<string, unknown>} depth={depth} />
  }

  // Function / symbol / etc — shouldn't appear in persisted JSON.
  return <span className="text-text-muted italic">({typeof value})</span>
}

function HumanString({ value }: { value: string }): ReactNode {
  // Image data URI: preview inline; click to enlarge.
  const dataKind = dataUriKind(value)
  if (dataKind === 'image') {
    return (
      <span className="inline-flex items-center gap-2">
        <ClickableImage
          src={value}
          alt="image"
          className="h-12 w-12 object-cover"
          caption={`image, ${formatBytes(approxByteLength(value))}`}
        />
        <span className="text-xs text-text-muted">image, {formatBytes(approxByteLength(value))}</span>
      </span>
    )
  }
  if (dataKind === 'audio') {
    return <audio controls src={value} className="h-8 max-w-xs" />
  }

  // URL: linkify.
  if (looksLikeUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="cursor-pointer break-all text-forest underline"
      >
        {value}
      </a>
    )
  }

  // Base64 blob (not a data URI): truncate, offer expand.
  if (looksLikeBase64(value)) {
    return <ExpandableString value={value} label={`base64, ${formatBytes(approxByteLength(value))}`} />
  }

  // Long human prose: collapsible.
  if (value.length > LONG_STRING_THRESHOLD) {
    return <ExpandableString value={value} />
  }

  return <span className="whitespace-pre-wrap break-words">{value}</span>
}

function ExpandableString({ value, label }: { value: string; label?: string }): ReactNode {
  const [open, setOpen] = useState(false)
  if (open) {
    return (
      <span className="block">
        <span className="block whitespace-pre-wrap break-words font-mono text-xs">{value}</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-1 cursor-pointer text-[11px] text-text-muted underline"
        >
          collapse
        </button>
      </span>
    )
  }
  const preview = value.slice(0, 80)
  return (
    <span>
      <span className="font-mono text-xs text-text-muted">{preview}…</span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-2 cursor-pointer text-[11px] text-text-muted underline"
      >
        {label ? `show full (${label})` : 'show full'}
      </button>
    </span>
  )
}

function HumanNumber({ value }: { value: number }): ReactNode {
  // Show large integers with thousand separators.
  if (Number.isInteger(value) && Math.abs(value) >= 1000) {
    return <span className="font-mono">{value.toLocaleString('en')}</span>
  }
  return <span className="font-mono">{value}</span>
}

function HumanBoolean({ value }: { value: boolean }): ReactNode {
  return (
    <span
      className={
        value
          ? 'inline-flex items-center gap-1 rounded bg-forest/10 px-1.5 py-0.5 text-[11px] font-medium text-forest'
          : 'inline-flex items-center gap-1 rounded bg-warm px-1.5 py-0.5 text-[11px] font-medium text-text-muted'
      }
    >
      {value ? 'true' : 'false'}
    </span>
  )
}

function HumanArray({
  items,
  depth,
}: {
  items: unknown[]
  depth: number
}): ReactNode {
  if (items.length === 0) {
    return <span className="text-text-muted italic">(empty list)</span>
  }

  // Render as columnar table when every item is an object with
  // overlapping keys — far easier to scan than a nested list.
  if (items.every((it) => isPlainObject(it)) && items.length >= 2) {
    const keys = uniqueKeys(items as Array<Record<string, unknown>>)
    if (keys.length > 0 && keys.length <= 8) {
      return <HumanTable rows={items as Array<Record<string, unknown>>} keys={keys} depth={depth} />
    }
  }

  return (
    <ul className="ml-3 list-disc space-y-1">
      {items.map((it, i) => (
        <li key={i} className="pl-1">
          <HumanValue value={it} depth={depth + 1} />
        </li>
      ))}
    </ul>
  )
}

function uniqueKeys(rows: Array<Record<string, unknown>>): string[] {
  const set = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) set.add(k)
  return Array.from(set)
}

function HumanTable({
  rows,
  keys,
  depth,
}: {
  rows: Array<Record<string, unknown>>
  keys: string[]
  depth: number
}): ReactNode {
  return (
    <table className="block w-full max-w-full overflow-x-auto border-collapse text-xs">
      <thead>
        <tr className="border-b border-warm text-left text-text-muted">
          {keys.map((k) => (
            <th key={k} className="px-2 py-1 font-medium">
              {humaniseKey(k)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-warm/50 align-top last:border-b-0">
            {keys.map((k) => (
              <td key={k} className="px-2 py-1">
                <HumanValue value={row[k]} depth={depth + 1} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function HumanObject({
  obj,
  depth,
}: {
  obj: Record<string, unknown>
  depth: number
}): ReactNode {
  const entries = Object.entries(obj)
  if (entries.length === 0) {
    return <span className="text-text-muted italic">(empty)</span>
  }

  const collapsible = depth >= COLLAPSE_DEFAULT_DEPTH && entries.length > 0
  return <ObjectRows entries={entries} depth={depth} startOpen={!collapsible} />
}

function ObjectRows({
  entries,
  depth,
  startOpen,
}: {
  entries: Array<[string, unknown]>
  depth: number
  startOpen: boolean
}): ReactNode {
  const [open, setOpen] = useState(startOpen)
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer text-[11px] text-text-muted underline"
      >
        show {entries.length} field{entries.length === 1 ? '' : 's'}
      </button>
    )
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
      {entries.map(([k, v]) => (
        <Row key={k} k={k} v={v} depth={depth} />
      ))}
    </dl>
  )
}

function Row({
  k,
  v,
  depth,
}: {
  k: string
  v: unknown
  depth: number
}): ReactNode {
  return (
    <>
      <dt className="pt-0.5 text-xs uppercase tracking-wide text-text-muted">{humaniseKey(k)}</dt>
      <dd className="min-w-0">
        <HumanValue value={v} depth={depth + 1} />
      </dd>
    </>
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
