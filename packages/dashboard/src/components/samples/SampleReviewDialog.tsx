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
 * Trace Evals enabled, the textarea would loop into a suggested
 * rewrite they could apply directly.
 */
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
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
import { ReviewSurface } from '../review/ReviewSurface'
import { TraceNavigator } from '../review/TraceNavigator'

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
  // The dialog defaults to the sample passed in by the table (the
  // page-of-results navigation context), but lets the reviewer
  // hop to a sibling trace step via the TraceNavigator. When the
  // page-of-results sample changes (prev/next), reset the override.
  const [overrideId, setOverrideId] = useState<string | null>(null)
  useEffect(() => {
    setOverrideId(null)
  }, [sample.id])
  const activeId = overrideId ?? sample.id
  const detailQ = useQuery<SampleDetailResponse>({
    queryKey: ['sample', activeId],
    queryFn: () => api.get<SampleDetailResponse>(`/api/samples/${activeId}`),
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
            sampleId={activeId}
            onAdvance={onAdvance}
            onJumpSibling={setOverrideId}
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
  onJumpSibling,
}: {
  data: SampleDetailResponse
  sampleId: string
  onAdvance: () => void
  onJumpSibling: (siblingId: string) => void
}) {
  const { sample, feedback, related } = data
  return (
    <div className="flex h-full flex-col">
      <MetadataStrip sample={sample} />
      {related && related.length > 0 && (
        <TraceNavigator
          related={related.map((r) => ({
            id: r.id,
            preview: previewForRelated(r),
            started_at: r.started_at,
            status: r.status,
          }))}
          currentSampleId={sample.id}
          currentPreview={previewForRelated(sample)}
          currentStartedAt={sample.started_at}
          onJump={onJumpSibling}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <ReviewSurface
          key={sampleId}
          name={sample.name}
          input={sample.input}
          output={sample.output}
          metadata={sample.metadata}
        />
      </div>
      <FeedbackPanel sampleId={sampleId} feedback={feedback} onAdvance={onAdvance} />
    </div>
  )
}

function previewForRelated(item: SampleListItem): string {
  // The server hasn't populated a dedicated `preview` field yet, so
  // fall back to the trace name. Trim the SDK prefix where present
  // (e.g. `fetch:openai.chat.completions.create` → `openai.chat…`).
  const name = item.name.startsWith('fetch:') ? item.name.slice('fetch:'.length) : item.name
  return name
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
