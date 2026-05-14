/**
 * JsonTree — collapsible, syntax-coloured JSON renderer.
 *
 * Inspired by `platform/src/components/dashboard/renderers/object-renderer.tsx`
 * but trimmed down: the dashboard only needs one generic tree fallback
 * for the "couldn't normalise this payload to a chat message" case, not
 * the 30-renderer pattern-detection ecosystem of `SmartDataRenderer`.
 *
 * Rules:
 *   - Objects + arrays render collapsible; deeper levels start closed.
 *   - Small flat objects render inline as `key: value · key: value`.
 *   - Primitives get a tint per type (string / number / boolean / null).
 *   - The whole tree exposes a "copy as JSON" button at the root.
 *
 * Why an inline component (not a dep): SmartDataRenderer pulls in
 * shadcn/ui + lucide + context providers + observation-pattern
 * detection. The Gravel dashboard would need ~30 files for what's
 * really a 100-line component.
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react'
import { cx } from '../../lib/format'

const INLINE_MAX_KEYS = 3
const AUTO_OPEN_DEPTH = 1

export function JsonTree({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard blocked — silent */
    }
  }
  return (
    <div className="relative rounded-md border border-warm bg-warm/20 p-2 text-xs">
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy as JSON"
        title="Copy as JSON"
        className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-warm hover:text-text-dark"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <div className="pr-7">
        <Node value={value} depth={0} />
      </div>
    </div>
  )
}

function Node({ value, depth, keyName }: { value: unknown; depth: number; keyName?: string }) {
  if (value === null) return <Primitive label="null" cls="text-text-muted italic" />
  if (value === undefined) return <Primitive label="undefined" cls="text-text-muted italic" />
  if (typeof value === 'string') return <StringValue text={value} />
  if (typeof value === 'number' || typeof value === 'bigint') {
    return <Primitive label={String(value)} cls="text-primary-dark" />
  }
  if (typeof value === 'boolean') {
    return <Primitive label={String(value)} cls="text-accent" />
  }
  if (Array.isArray(value)) return <ArrayNode arr={value} depth={depth} keyName={keyName} />
  if (typeof value === 'object') {
    return <ObjectNode obj={value as Record<string, unknown>} depth={depth} keyName={keyName} />
  }
  return <Primitive label={String(value)} cls="text-text-dark" />
}

function Primitive({ label, cls }: { label: string; cls: string }) {
  return <span className={cx('font-mono', cls)}>{label}</span>
}

function StringValue({ text }: { text: string }) {
  if (text === '') return <Primitive label='""' cls="text-text-muted italic" />
  const long = text.length > 200
  const [expanded, setExpanded] = useState(false)
  if (!long || expanded) {
    return (
      <span className="break-words font-mono text-forest">
        &quot;{text}&quot;
        {long && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-2 cursor-pointer text-[10px] text-text-muted underline"
          >
            shorten
          </button>
        )}
      </span>
    )
  }
  return (
    <span className="break-words font-mono text-forest">
      &quot;{text.slice(0, 200)}…&quot;{' '}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="cursor-pointer text-[10px] text-text-muted underline"
      >
        show {text.length - 200} more chars
      </button>
    </span>
  )
}

function ObjectNode({
  obj,
  depth,
  keyName,
}: {
  obj: Record<string, unknown>
  depth: number
  keyName?: string
}) {
  const entries = Object.entries(obj)
  const [open, setOpen] = useState(depth <= AUTO_OPEN_DEPTH)

  if (entries.length === 0) {
    return <Primitive label="{}" cls="text-text-muted italic" />
  }

  // Inline render for tiny flat objects — easier to scan than a tree
  // node with its own toggle. Mirrors ObjectRenderer's INLINE heuristic.
  const allPrim = entries.every(([, v]) => v === null || typeof v !== 'object')
  if (allPrim && entries.length <= INLINE_MAX_KEYS) {
    return (
      <span className="font-mono">
        {entries.map(([k, v], i) => (
          <span key={k}>
            {i > 0 && <span className="text-text-muted"> · </span>}
            <span className="text-text-muted">{k}:</span> <Node value={v} depth={depth + 1} />
          </span>
        ))}
      </span>
    )
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-text-muted hover:text-text-dark"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="font-mono">
          {keyName ? `${keyName} ` : ''}
          {`{${entries.length}}`}
        </span>
      </button>
      {open && (
        <div className="ml-4 space-y-1 border-l border-warm pl-3">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2">
              <span className="font-mono text-text-mid">{k}:</span>
              <div className="min-w-0 flex-1">
                <Node value={v} depth={depth + 1} keyName={k} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ArrayNode({ arr, depth, keyName }: { arr: unknown[]; depth: number; keyName?: string }) {
  const [open, setOpen] = useState(depth <= AUTO_OPEN_DEPTH)
  if (arr.length === 0) {
    return <Primitive label="[]" cls="text-text-muted italic" />
  }
  // Flat primitive arrays render inline as comma-separated tokens.
  const allPrim = arr.every((v) => v === null || typeof v !== 'object')
  if (allPrim && arr.length <= 10) {
    return (
      <span className="font-mono">
        [
        {arr.map((v, i) => (
          <span key={i}>
            {i > 0 && <span className="text-text-muted">, </span>}
            <Node value={v} depth={depth + 1} />
          </span>
        ))}
        ]
      </span>
    )
  }
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-text-muted hover:text-text-dark"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="font-mono">
          {keyName ? `${keyName} ` : ''}
          {`[${arr.length}]`}
        </span>
      </button>
      {open && (
        <div className="ml-4 space-y-1 border-l border-warm pl-3">
          {arr.map((v, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="font-mono text-text-muted">{i}:</span>
              <div className="min-w-0 flex-1">
                <Node value={v} depth={depth + 1} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
