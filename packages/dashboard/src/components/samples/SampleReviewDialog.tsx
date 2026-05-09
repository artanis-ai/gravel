/**
 * The Review-tab modal: read one sample, leave feedback, auto-advance
 * to the next.
 *
 * Layout (top → bottom):
 *   ┌─ toolbar: prev / next / position / close ────────────────────┐
 *   ├─ metadata strip: model / env / status / duration / when ─────┤
 *   ├─ INPUT (rendered messages)        OUTPUT (rendered) ─────────┤
 *   └─ feedback panel ─────────────────────────────────────────────┘
 *
 * Feedback flow (matches the spec):
 *   1. Two big buttons: "Looks good" / "Looks wrong".
 *   2. "Looks wrong" reveals a textarea ("what's off?") plus Submit.
 *   3. On submit → POST → invalidate → advance to next sample. If
 *      we're already on the last one, close.
 *   4. Existing feedback is shown above the form so reviewers don't
 *      duplicate themselves.
 *
 * Judge upgrade hint: rendered as a localhost-only DeveloperNote at
 * the bottom of the feedback panel — telling the dev that with the
 * Artanis judge enabled, the textarea would loop into a suggested
 * rewrite they could apply directly.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import { api } from '../../lib/api'
import {
  type FeedbackItem,
  type SampleDetailResponse,
  type SampleListItem,
  type SampleStatus,
} from '../../lib/types'
import { Dialog } from '../Dialog'
import { Badge } from '../Badge'
import { SkeletonText } from '../Skeleton'
import { cx, formatDuration, formatRelative } from '../../lib/format'
import { extractMessages, extractOutput, type ContentBlock, type NormalizedMessage } from '../../lib/messages'

interface Props {
  /** All samples currently on screen (one page of the table). Drives prev/next. */
  samples: SampleListItem[]
  /** Index into `samples`. -1 means closed. */
  index: number
  onIndexChange: (next: number) => void
  onClose: () => void
}

export function SampleReviewDialog({ samples, index, onIndexChange, onClose }: Props) {
  const open = index >= 0 && index < samples.length
  const sample = open ? samples[index] : null
  const queryClient = useQueryClient()

  // Keyboard nav: ←/→ jumps; Esc handled by Dialog.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      // Don't hijack typing inside the textarea.
      const t = e.target as HTMLElement | null
      if (t?.tagName === 'TEXTAREA' || t?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1)
      else if (e.key === 'ArrowRight' && index < samples.length - 1) onIndexChange(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, index, samples.length, onIndexChange])

  // Prefetch the next + previous few samples so prev/next feels
  // instant. The detail query is cheap (single `/api/samples/:id`
  // hit) and React Query dedupes against the active query, so
  // re-prefetching while one is in-flight is a no-op.
  useEffect(() => {
    if (!open) return
    const ids = neighbouringIds(samples, index, 3)
    for (const id of ids) prefetchSample(queryClient, id)
  }, [open, index, samples, queryClient])

  return (
    <Dialog open={open} onClose={onClose} ariaLabel="Review sample">
      {sample && (
        <DialogBody
          sample={sample}
          position={index + 1}
          total={samples.length}
          hasPrev={index > 0}
          hasNext={index < samples.length - 1}
          onPrev={() => onIndexChange(index - 1)}
          onNext={() => onIndexChange(index + 1)}
          onClose={onClose}
          onAdvance={() => {
            if (index < samples.length - 1) onIndexChange(index + 1)
            else onClose()
          }}
        />
      )}
    </Dialog>
  )
}

interface DialogBodyProps {
  sample: SampleListItem
  position: number
  total: number
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  /** Called after a feedback submit lands. Default behaviour: jump to next, close on last. */
  onAdvance: () => void
}

function DialogBody({
  sample,
  position,
  total,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onAdvance,
}: DialogBodyProps) {
  const detailQ = useQuery<SampleDetailResponse>({
    queryKey: ['sample', sample.id],
    queryFn: () => api.get<SampleDetailResponse>(`/api/samples/${sample.id}`),
  })

  return (
    <>
      <Toolbar
        position={position}
        total={total}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={onPrev}
        onNext={onNext}
        onClose={onClose}
      />
      <div className="flex flex-1 min-h-0 flex-col">
        {detailQ.isLoading ? (
          <div className="p-6">
            <SkeletonText lines={2} />
            <div className="mt-4">
              <SkeletonText lines={8} />
            </div>
          </div>
        ) : detailQ.isError || !detailQ.data ? (
          <div className="p-6 text-sm text-primary-dark">
            Failed to load: {(detailQ.error as Error)?.message ?? 'unknown error'}
          </div>
        ) : (
          <DialogContent
            data={detailQ.data}
            sampleId={sample.id}
            onAdvance={onAdvance}
          />
        )}
      </div>
    </>
  )
}

function Toolbar({
  position,
  total,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
}: {
  position: number
  total: number
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}) {
  // 3-column grid keeps the position counter visually centred even
  // though the close button is on the right; the empty cell + close
  // cell on the right balance the empty cell + nav-cluster on the left.
  return (
    <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-warm bg-cream/95 px-4 py-2">
      <div /> {/* spacer */}
      <div className="flex items-center gap-2 justify-self-center">
        <NavButton onClick={onPrev} disabled={!hasPrev} ariaLabel="Previous sample">
          ←
        </NavButton>
        <span
          // Fixed width so the counter doesn't jiggle the arrows when
          // the digit count grows (1/9 → 10/99 → 100/999).
          className="inline-block w-20 text-center font-mono text-xs tabular-nums text-text-mid"
        >
          {position} / {total}
        </span>
        <NavButton onClick={onNext} disabled={!hasNext} ariaLabel="Next sample">
          →
        </NavButton>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="cursor-pointer justify-self-end rounded-md p-1.5 text-text-mid hover:bg-warm hover:text-text-dark"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}

function NavButton({
  children,
  onClick,
  disabled,
  ariaLabel,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled: boolean
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cx(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-sm font-mono',
        disabled ? 'cursor-not-allowed text-text-muted' : 'cursor-pointer text-text-mid hover:bg-warm hover:text-text-dark',
      )}
    >
      {children}
    </button>
  )
}

function DialogContent({
  data,
  sampleId,
  onAdvance,
}: {
  data: SampleDetailResponse
  sampleId: string
  onAdvance: () => void
}) {
  const { sample, feedback } = data
  const messages = useMemo(() => extractMessages(sample.input), [sample.input])
  const output = useMemo(() => extractOutput(sample.output), [sample.output])

  // Collapse defaults:
  //   - system: collapsed (long static instructions).
  //   - user: collapsed except the LAST user message, which is the
  //     turn the assistant responded to and what the reviewer needs
  //     to see immediately.
  //   - assistant / tool / other: open.
  const lastUserIdx = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1)
  const initialOpen = (m: NormalizedMessage, i: number) => {
    if (m.role === 'system') return false
    if (m.role === 'user') return i === lastUserIdx
    return true
  }

  return (
    <div className="flex h-full flex-col">
      <MetadataStrip sample={sample} />
      <div className="grid flex-1 min-h-0 gap-px bg-warm/60 md:grid-cols-2">
        <Pane label="Input" subtitle={`${messages.length} message${messages.length === 1 ? '' : 's'}`}>
          {messages.length > 0 ? (
            <div className="space-y-3">
              {messages.map((m, i) => (
                <MessageView key={i} message={m} initiallyOpen={initialOpen(m, i)} />
              ))}
            </div>
          ) : (
            <RawJson value={sample.input} />
          )}
        </Pane>
        <Pane label="Output">
          {output.length > 0 ? (
            <div className="space-y-3">
              {output.map((m, i) => (
                <MessageView key={i} message={m} initiallyOpen omitHeader={output.length === 1} />
              ))}
            </div>
          ) : (
            <RawJson value={sample.output} />
          )}
        </Pane>
      </div>
      <FeedbackPanel sampleId={sampleId} feedback={feedback} onAdvance={onAdvance} />
    </div>
  )
}

function MetadataStrip({
  sample,
}: {
  sample: SampleDetailResponse['sample']
}) {
  return (
    <dl className="grid grid-cols-2 gap-px border-b border-warm bg-warm/60 sm:grid-cols-4 md:grid-cols-6">
      <Meta label="Name" value={<span className="font-mono">{sample.name}</span>} />
      <Meta label="Model" value={<span className="font-mono">{sample.model ?? '—'}</span>} />
      <Meta label="Env" value={sample.environment ?? '—'} />
      <Meta label="Status" value={<StatusBadge status={sample.status} />} />
      <Meta label="Duration" value={<span className="font-mono">{formatDuration(sample.duration_ms)}</span>} />
      <Meta label="When" value={formatRelative(sample.started_at)} />
    </dl>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-cream px-3 py-2">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-xs text-text-dark">{value}</dd>
    </div>
  )
}

function Pane({
  label,
  subtitle,
  children,
}: {
  label: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    // `min-h-0` is what lets the inner `overflow-y-auto` actually scroll
    // inside a flex parent — without it the pane grows to fit content.
    <section className="flex min-h-0 flex-col bg-cream">
      <header className="flex shrink-0 items-baseline justify-between border-b border-warm/60 px-4 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-mid">{label}</h3>
        {subtitle && <span className="text-[11px] text-text-muted">{subtitle}</span>}
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3 text-sm text-text-dark">{children}</div>
    </section>
  )
}

function MessageView({
  message,
  initiallyOpen,
  omitHeader,
}: {
  message: NormalizedMessage
  initiallyOpen: boolean
  /** Drop the role chrome entirely — used when the output pane has a
   *  single assistant message and the role label is just visual noise. */
  omitHeader?: boolean
}) {
  const { role, blocks } = message
  const tone =
    role === 'system'
      ? 'border-warm bg-warm/20 text-text-mid'
      : role === 'user'
        ? 'border-primary/30 bg-primary/5 text-text-dark'
        : role === 'tool' || role === 'function'
          ? 'border-earth/30 bg-earth/5 text-text-dark'
          : 'border-forest/30 bg-forest/5 text-text-dark'
  const [open, setOpen] = useState(initiallyOpen)
  if (omitHeader) {
    return (
      <article className={cx('rounded-lg border p-3', tone)}>
        <BlockList blocks={blocks} />
      </article>
    )
  }
  return (
    <article className={cx('rounded-lg border', tone)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-text-muted hover:text-text-dark"
        aria-expanded={open}
      >
        <span aria-hidden="true" className="font-mono text-[10px]">
          {open ? '▾' : '▸'}
        </span>
        <span>{role}</span>
        {!open && (
          <span className="ml-2 truncate font-normal normal-case text-text-muted">
            {summarizeBlocks(blocks)}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-current/10 px-3 py-2">
          <BlockList blocks={blocks} />
        </div>
      )}
    </article>
  )
}

function BlockList({ blocks }: { blocks: ContentBlock[] }) {
  if (blocks.length === 0) {
    return <p className="text-xs italic text-text-muted">(empty)</p>
  }
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  )
}

function BlockView({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return <Markdown>{block.text}</Markdown>
    case 'reasoning':
      return (
        <div className="rounded-md border border-text-muted/30 bg-warm/30 p-2 text-xs italic text-text-mid">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide not-italic">reasoning</div>
          <Markdown>{block.text}</Markdown>
        </div>
      )
    case 'image':
      return <ImageBlock block={block} />
    case 'file':
      return <FileBlock block={block} />
    case 'tool_call':
      return <ToolCallBlock block={block} />
    case 'tool_result':
      return <ToolResultBlock block={block} />
    case 'unknown':
      return <RawJson value={block.raw} />
  }
}

function ImageBlock({ block }: { block: Extract<ContentBlock, { type: 'image' }> }) {
  if (!block.url) {
    return (
      <div className="rounded-md border border-warm bg-warm/20 px-3 py-2 text-xs text-text-mid">
        🖼 image (no URL){block.mediaType ? ` · ${block.mediaType}` : ''}
      </div>
    )
  }
  return (
    <figure className="overflow-hidden rounded-md border border-warm bg-warm/20">
      <img src={block.url} alt={block.alt ?? 'attachment'} className="max-h-80 w-auto" />
      <figcaption className="px-3 py-1.5 text-[10px] text-text-muted">
        🖼 image{block.mediaType ? ` · ${block.mediaType}` : ''}
        {block.rawSize ? ` · ${formatSize(block.rawSize)}` : ''}
      </figcaption>
    </figure>
  )
}

function FileBlock({ block }: { block: Extract<ContentBlock, { type: 'file' }> }) {
  const isPdf = (block.mediaType ?? '').includes('pdf') || (block.name ?? '').toLowerCase().endsWith('.pdf')
  if (isPdf && block.url) {
    return (
      <div className="overflow-hidden rounded-md border border-warm">
        <iframe src={block.url} title={block.name ?? 'PDF'} className="h-72 w-full bg-white" />
        <div className="border-t border-warm bg-warm/20 px-3 py-1.5 text-[10px] text-text-muted">
          📄 {block.name ?? 'document'}{block.mediaType ? ` · ${block.mediaType}` : ''}
          {block.url && (
            <>
              {' · '}
              <a href={block.url} target="_blank" rel="noopener noreferrer" className="cursor-pointer underline">
                open
              </a>
            </>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-warm bg-warm/20 px-3 py-2 text-xs text-text-mid">
      <span>📄 {block.name ?? 'attachment'}{block.mediaType ? ` · ${block.mediaType}` : ''}</span>
      {block.url && (
        <a href={block.url} target="_blank" rel="noopener noreferrer" className="cursor-pointer underline hover:text-text-dark">
          open
        </a>
      )}
    </div>
  )
}

function ToolCallBlock({ block }: { block: Extract<ContentBlock, { type: 'tool_call' }> }) {
  return (
    <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-text-mid">
        <span className="font-mono text-[10px] uppercase tracking-wide text-accent">tool call</span>
        <span className="font-mono font-medium text-text-dark">{block.name || '(no name)'}</span>
        {block.id && <span className="font-mono text-[10px] text-text-muted">#{block.id.slice(-6)}</span>}
      </div>
      <div className="mt-1.5">
        <HumanValue value={block.input} />
      </div>
    </div>
  )
}

function ToolResultBlock({ block }: { block: Extract<ContentBlock, { type: 'tool_result' }> }) {
  const tone = block.isError ? 'border-primary/40 bg-primary/10' : 'border-earth/40 bg-earth/10'
  return (
    <div className={cx('rounded-md border px-3 py-2 text-xs', tone)}>
      <div className="flex items-center gap-2 text-text-mid">
        <span className="font-mono text-[10px] uppercase tracking-wide">
          tool result{block.isError ? ' · error' : ''}
        </span>
        {block.toolCallId && (
          <span className="font-mono text-[10px] text-text-muted">#{block.toolCallId.slice(-6)}</span>
        )}
      </div>
      <div className="mt-1.5">
        <HumanValue value={parseMaybeJson(block.output)} />
      </div>
    </div>
  )
}

/**
 * Human-readable renderer for arbitrary JSON values. Maps:
 *   - Null/empty            → "(none)"
 *   - Primitives (str/num)  → plain text (mono for non-strings)
 *   - Arrays of primitives  → comma-separated chips
 *   - Objects (flat)        → definition list of key: value rows
 *   - Nested objects/arrays → recursive
 *
 * Falls back to a `<pre>` JSON dump only when the structure is too
 * dense to read inline (10+ keys, or 4+ levels of nesting).
 */
function HumanValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null) return <span className="text-text-muted italic">(none)</span>
  if (typeof value === 'string') {
    if (value === '') return <span className="text-text-muted italic">(empty string)</span>
    return <span className="break-words text-text-dark">{value}</span>
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="font-mono text-text-dark">{String(value)}</span>
  }
  if (typeof value !== 'object') {
    return <span className="font-mono text-text-dark">{String(value)}</span>
  }
  // Bail to JSON for very deep / large structures — render quality
  // tanks below this threshold and the user is better off with a code
  // dump they can copy.
  if (depth >= 4) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-cream p-2 font-mono text-[11px] text-text-dark">
        {safeJson(value)}
      </pre>
    )
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-text-muted italic">(empty list)</span>
    }
    const allPrim = value.every((v) => v == null || typeof v !== 'object')
    if (allPrim) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((v, i) => (
            <span key={i} className="rounded bg-cream px-1.5 py-0.5 font-mono text-[11px] text-text-dark">
              {v == null ? 'null' : String(v)}
            </span>
          ))}
        </div>
      )
    }
    return (
      <ol className="list-decimal space-y-1 pl-5">
        {value.map((v, i) => (
          <li key={i}>
            <HumanValue value={v} depth={depth + 1} />
          </li>
        ))}
      </ol>
    )
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return <span className="text-text-muted italic">(empty object)</span>
  }
  if (entries.length > 10) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-cream p-2 font-mono text-[11px] text-text-dark">
        {safeJson(value)}
      </pre>
    )
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="font-mono text-[11px] text-text-mid">{k}</dt>
          <dd className="text-xs text-text-dark">
            <HumanValue value={v} depth={depth + 1} />
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** Tool-result `output` from OpenAI tool messages comes through as a JSON
 *  string; parse if it looks like one so HumanValue can render fields. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function summarizeBlocks(blocks: ContentBlock[]): string {
  for (const b of blocks) {
    if (b.type === 'text' || b.type === 'reasoning') {
      return b.text.replace(/\s+/g, ' ').slice(0, 80) + (b.text.length > 80 ? '…' : '')
    }
    if (b.type === 'tool_call') return `🔧 ${b.name}`
    if (b.type === 'tool_result') return b.isError ? '🔧 result · error' : '🔧 result'
    if (b.type === 'image') return '🖼 image'
    if (b.type === 'file') return `📄 ${b.name ?? 'attachment'}`
  }
  return '(empty)'
}

function formatSize(b64Length: number): string {
  // base64 → bytes is *3/4. Round.
  const bytes = Math.round((b64Length * 3) / 4)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-sm max-w-none whitespace-pre-wrap break-words text-sm leading-relaxed text-text-dark [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-warm/40 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-warm/40 [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-[12px] [&_strong]:font-semibold [&_ul]:ml-4 [&_ul]:list-disc [&_ol]:ml-4 [&_ol]:list-decimal">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  )
}

function RawJson({ value }: { value: unknown }) {
  return (
    <pre className="whitespace-pre-wrap rounded-md bg-warm/30 p-3 font-mono text-[11px] text-text-dark">
      {safeJson(value)}
    </pre>
  )
}

function StatusBadge({ status }: { status: SampleStatus }) {
  if (status === 'completed') return <Badge tone="good" icon="✓">ok</Badge>
  if (status === 'errored') return <Badge tone="bad" icon="✕">error</Badge>
  return <Badge tone="info" icon="●">running</Badge>
}

// ---------- Feedback ----------

function FeedbackPanel({
  sampleId,
  feedback,
  onAdvance,
}: {
  sampleId: string
  feedback: FeedbackItem[]
  /** Called after a feedback submit OR a Skip — both advance to the next sample. */
  onAdvance: () => void
}) {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [showReason, setShowReason] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset local state when navigating samples.
  useEffect(() => {
    setReason('')
    setShowReason(false)
    setError(null)
  }, [sampleId])

  const submit = useMutation<unknown, Error, { score: 'positive' | 'negative'; comment: string | null }>({
    mutationFn: ({ score, comment }) =>
      api.post(`/api/samples/${sampleId}/feedback`, {
        score,
        comment,
        correction: null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sample', sampleId] })
      queryClient.invalidateQueries({ queryKey: ['samples'] })
      onAdvance()
    },
    onError: (err) => setError(err.message),
  })

  const approve = () => {
    setError(null)
    submit.mutate({ score: 'positive', comment: null })
  }
  const flagBad = () => {
    setShowReason(true)
    setError(null)
  }
  const skip = () => onAdvance()
  const submitReason = () => {
    if (!reason.trim()) {
      setError('Tell us what was wrong so the next iteration can do better.')
      return
    }
    submit.mutate({ score: 'negative', comment: reason.trim() })
  }

  // Keyboard shortcuts: C / W / S when not typing in a textarea/input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t?.tagName === 'TEXTAREA' || t?.tagName === 'INPUT') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'c') {
        e.preventDefault()
        approve()
      } else if (k === 'w') {
        e.preventDefault()
        flagBad()
      } else if (k === 's') {
        e.preventDefault()
        skip()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // approve/flagBad/skip close over `submit` and `onAdvance`, both
    // captured per-render via the mutation hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId, showReason])

  return (
    <section className="border-t border-warm bg-warm/20 px-4 py-3">
      {feedback.length > 0 && <ExistingFeedback items={feedback} />}
      {!showReason ? (
        <div className="flex items-center justify-center gap-3">
          <FeedbackButton tone="correct" shortcut="C" onClick={approve} disabled={submit.isPending}>
            ✓ Correct
          </FeedbackButton>
          <FeedbackButton tone="wrong" shortcut="W" onClick={flagBad} disabled={submit.isPending}>
            ✕ Wrong
          </FeedbackButton>
          <FeedbackButton tone="skip" shortcut="S" onClick={skip} disabled={submit.isPending}>
            ↷ Skip
          </FeedbackButton>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block text-sm text-text-mid" htmlFor="feedback-reason">
            What's wrong with it?
          </label>
          <textarea
            id="feedback-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Be specific — the next iteration learns from this."
            className="w-full rounded-md border border-warm bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShowReason(false)
                setReason('')
                setError(null)
              }}
              className="cursor-pointer rounded-lg px-3 py-1.5 text-sm text-text-mid hover:text-text-dark"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitReason}
              disabled={submit.isPending}
              className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submit.isPending ? 'Saving…' : 'Submit feedback'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-primary-dark">{error}</p>}
    </section>
  )
}

function ExistingFeedback({ items }: { items: FeedbackItem[] }) {
  return (
    <ul className="mb-3 space-y-1.5">
      {items.map((f) => (
        <li key={f.id} className="rounded-md border border-warm bg-cream px-3 py-2 text-xs">
          <div className="flex items-center gap-2 text-text-mid">
            <Badge tone={f.score === 'positive' ? 'good' : f.score === 'negative' ? 'bad' : 'neutral'}>
              {f.score === 'positive' ? '✓ correct' : f.score === 'negative' ? '✕ wrong' : 'noted'}
            </Badge>
            <span>{formatRelative(f.created_at)}</span>
          </div>
          {f.comment && <p className="mt-1 text-text-dark">{f.comment}</p>}
        </li>
      ))}
    </ul>
  )
}

function FeedbackButton({
  tone,
  shortcut,
  onClick,
  disabled,
  children,
}: {
  tone: 'correct' | 'wrong' | 'skip'
  shortcut: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  const styles = {
    correct: 'border-forest/40 bg-forest/10 text-forest hover:bg-forest/20',
    wrong: 'border-primary/40 bg-primary/10 text-primary-dark hover:bg-primary/20',
    skip: 'border-warm bg-cream text-text-mid hover:bg-warm/40',
  }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={`Shortcut: ${shortcut}`}
      className={cx(
        'group inline-flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
        styles,
      )}
    >
      <span>{children}</span>
      <kbd className="rounded border border-current/30 bg-cream/60 px-1.5 py-0 font-mono text-[10px] font-semibold text-current/70">
        {shortcut}
      </kbd>
    </button>
  )
}

// ---------- Helpers ----------

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** IDs for the `radius` samples on each side of `index`, clamped to the array. */
function neighbouringIds(samples: SampleListItem[], index: number, radius: number): string[] {
  const ids: string[] = []
  for (let d = 1; d <= radius; d++) {
    if (index - d >= 0) ids.push(samples[index - d]!.id)
    if (index + d < samples.length) ids.push(samples[index + d]!.id)
  }
  return ids
}

function prefetchSample(qc: QueryClient, id: string): void {
  void qc.prefetchQuery({
    queryKey: ['sample', id],
    queryFn: () => api.get<SampleDetailResponse>(`/api/samples/${id}`),
    // Keep the prefetched detail fresh long enough that arrowing
    // through 3-5 samples doesn't refetch each time.
    staleTime: 60_000,
  })
}
