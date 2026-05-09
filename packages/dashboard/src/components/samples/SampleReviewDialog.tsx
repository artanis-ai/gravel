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
import { useEffect, useMemo, useState } from 'react'
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
  const outputText = useMemo(() => extractOutputText(sample.output), [sample.output])

  // The dialog body is a vertical flex column inside a 100vh-2rem
  // shell. The two-pane row (`flex-1`) takes everything between the
  // metadata strip and the feedback panel, with each pane scrolling
  // its own content.
  return (
    <div className="flex h-full flex-col">
      <MetadataStrip sample={sample} />
      <div className="grid flex-1 min-h-0 gap-px bg-warm/60 md:grid-cols-2">
        <Pane label="Input" subtitle={`${messages.length} message${messages.length === 1 ? '' : 's'}`}>
          {messages.length > 0 ? (
            <div className="space-y-3">
              {messages.map((m, i) => (
                <MessageView key={i} role={m.role} content={m.content} />
              ))}
            </div>
          ) : (
            <RawJson value={sample.input} />
          )}
        </Pane>
        <Pane label="Output">
          {outputText !== null ? (
            <Markdown>{outputText}</Markdown>
          ) : (
            <RawJson value={sample.output} />
          )}
        </Pane>
      </div>
      <FeedbackPanel sampleId={sampleId} feedback={feedback} onSubmitted={onAdvance} />
    </div>
  )
}

function MetadataStrip({
  sample,
}: {
  sample: SampleDetailResponse['sample']
}) {
  return (
    <dl className="grid grid-cols-2 gap-px bg-warm/60 sm:grid-cols-4 md:grid-cols-6">
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

function MessageView({ role, content }: { role: string; content: string }) {
  const tone =
    role === 'system'
      ? 'border-warm bg-warm/20 text-text-mid'
      : role === 'user'
        ? 'border-primary/30 bg-primary/5 text-text-dark'
        : 'border-forest/30 bg-forest/5 text-text-dark'
  // System messages are usually long, static instructions — collapse
  // them by default so the user-visible content of the call (the
  // user/assistant turn) is what dominates the pane.
  const collapsible = role === 'system'
  const [open, setOpen] = useState(!collapsible)
  return (
    <article className={cx('rounded-lg border', tone)}>
      <button
        type="button"
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
        disabled={!collapsible}
        className={cx(
          'flex w-full items-center gap-2 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-text-muted',
          collapsible && 'cursor-pointer hover:text-text-dark',
        )}
        aria-expanded={collapsible ? open : undefined}
      >
        {collapsible && (
          <span aria-hidden="true" className="font-mono text-[10px]">
            {open ? '▾' : '▸'}
          </span>
        )}
        <span>{role}</span>
        {collapsible && !open && (
          <span className="ml-2 truncate font-normal normal-case text-text-muted">
            {content.replace(/\s+/g, ' ').slice(0, 80)}
            {content.length > 80 ? '…' : ''}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-current/10 px-3 py-2">
          <Markdown>{content}</Markdown>
        </div>
      )}
    </article>
  )
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
  onSubmitted,
}: {
  sampleId: string
  feedback: FeedbackItem[]
  onSubmitted: () => void
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
      onSubmitted()
    },
    onError: (err) => setError(err.message),
  })

  function approve() {
    setError(null)
    submit.mutate({ score: 'positive', comment: null })
  }

  function flagBad() {
    setShowReason(true)
    setError(null)
  }

  function submitReason() {
    if (!reason.trim()) {
      setError('Tell us what was wrong so the next iteration can do better.')
      return
    }
    submit.mutate({ score: 'negative', comment: reason.trim() })
  }

  return (
    <section className="border-t border-warm bg-warm/20 px-4 py-3">
      {feedback.length > 0 && <ExistingFeedback items={feedback} />}
      {!showReason ? (
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={approve}
            disabled={submit.isPending}
            className="cursor-pointer rounded-lg border border-forest/40 bg-forest/10 px-4 py-1.5 text-sm font-medium text-forest hover:bg-forest/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ✓ Looks good
          </button>
          <button
            type="button"
            onClick={flagBad}
            disabled={submit.isPending}
            className="cursor-pointer rounded-lg border border-primary/40 bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary-dark hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ✕ Looks wrong
          </button>
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
              {f.score === 'positive' ? '↑' : f.score === 'negative' ? '↓' : '·'}
            </Badge>
            <span>{formatRelative(f.created_at)}</span>
          </div>
          {f.comment && <p className="mt-1 text-text-dark">{f.comment}</p>}
        </li>
      ))}
    </ul>
  )
}

// ---------- Helpers ----------

interface ChatMessage {
  role: string
  content: string
}

/** Pull a chat-message array out of common request shapes. Tolerant: returns []
 *  when the input doesn't look like a chat completion (raw fetch, custom shape). */
function extractMessages(input: unknown): ChatMessage[] {
  if (!input || typeof input !== 'object') return []
  // OpenAI / Anthropic raw-fetch shape: { url, method, body: { messages: [...] } }
  const obj = input as Record<string, unknown>
  const direct = obj.messages
  if (Array.isArray(direct)) return normalizeMessages(direct)
  const body = obj.body
  if (body && typeof body === 'object') {
    const m = (body as Record<string, unknown>).messages
    if (Array.isArray(m)) return normalizeMessages(m)
    // Anthropic: body.system + body.messages
    const system = (body as Record<string, unknown>).system
    const msgs = (body as Record<string, unknown>).messages
    if (Array.isArray(msgs)) {
      const out = normalizeMessages(msgs)
      if (typeof system === 'string') out.unshift({ role: 'system', content: system })
      return out
    }
  }
  return []
}

function normalizeMessages(raw: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const obj = m as Record<string, unknown>
    const role = typeof obj.role === 'string' ? obj.role : 'unknown'
    const content = obj.content
    if (typeof content === 'string') out.push({ role, content })
    else if (Array.isArray(content)) {
      // Anthropic-style content blocks: [{type: 'text', text: '...'}, ...]
      const text = content
        .map((c) => {
          if (!c || typeof c !== 'object') return ''
          const block = c as Record<string, unknown>
          if (typeof block.text === 'string') return block.text
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
      out.push({ role, content: text })
    } else {
      out.push({ role, content: safeJson(content) })
    }
  }
  return out
}

/** Pull the assistant text out of common response shapes. */
function extractOutputText(output: unknown): string | null {
  if (output == null) return null
  if (typeof output === 'string') return output
  if (typeof output !== 'object') return String(output)
  const obj = output as Record<string, unknown>
  // OpenAI: { choices: [{ message: { content } }] }
  const choices = obj.choices
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const m = (choices[0] as Record<string, unknown>).message
    if (m && typeof m === 'object') {
      const c = (m as Record<string, unknown>).content
      if (typeof c === 'string') return c
    }
    // Older completions: { choices: [{ text }] }
    const t = (choices[0] as Record<string, unknown>).text
    if (typeof t === 'string') return t
  }
  // Anthropic: { content: [{type: 'text', text}] }
  const content = obj.content
  if (Array.isArray(content)) {
    const text = content
      .map((c) => {
        if (!c || typeof c !== 'object') return ''
        const block = c as Record<string, unknown>
        if (typeof block.text === 'string') return block.text
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
    if (text) return text
  }
  // Vercel AI: { text } (sometimes), or direct string
  if (typeof obj.text === 'string') return obj.text
  return null
}

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
