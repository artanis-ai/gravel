/**
 * TraceNavigator — horizontal step strip at the top of the review
 * dialog for multi-step traces.
 *
 * Shown only when `related[]` is non-empty: the sample belongs to a
 * `group_id` with siblings. Steps are ordered by `started_at` and
 * presented as buttons (⬤ filled for the active step, ◯ outlined
 * for siblings) with a short preview underneath. Clicking a sibling
 * fires `onJump(sampleId)`; the dialog is responsible for refetching.
 *
 * The component itself is dumb: no data fetching, no routing — it
 * just renders + reports clicks. That keeps it trivially testable.
 */
import type { ReactNode } from 'react'

interface TraceStep {
  id: string
  preview: string | null
  started_at: string | null
  status?: string | null
}

interface TraceNavigatorProps {
  /** Sibling samples sharing the same `group_id` as the currently
   *  open sample. Already ordered by the server, but we re-sort by
   *  `started_at` defensively. */
  related: TraceStep[]
  /** The currently-open sample's ID. Used to highlight the active
   *  step and to slot it into the right position in the strip when
   *  the server's `related[]` excludes the open sample itself. */
  currentSampleId: string
  /** Preview text for the active step (so the strip is complete
   *  even when the current sample isn't repeated in `related`). */
  currentPreview?: string | null
  currentStartedAt?: string | null
  onJump: (sampleId: string) => void
}

export function TraceNavigator({
  related,
  currentSampleId,
  currentPreview,
  currentStartedAt,
  onJump,
}: TraceNavigatorProps): ReactNode {
  const steps = mergeAndSortSteps(related, currentSampleId, currentPreview, currentStartedAt)
  if (steps.length <= 1) return null

  const activeIndex = steps.findIndex((s) => s.id === currentSampleId)
  const total = steps.length

  return (
    <nav
      aria-label="Trace steps"
      className="flex shrink-0 items-stretch gap-0 overflow-x-auto border-b border-warm bg-warm/10 px-3 py-2 text-xs"
    >
      <div className="mr-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-muted">
        <span>Trace</span>
        <span className="font-mono">
          {activeIndex >= 0 ? activeIndex + 1 : '?'} / {total}
        </span>
      </div>
      <ol className="flex flex-1 items-stretch gap-0">
        {steps.map((step, i) => (
          <Step
            key={step.id}
            step={step}
            index={i}
            total={total}
            active={step.id === currentSampleId}
            onClick={() => onJump(step.id)}
          />
        ))}
      </ol>
    </nav>
  )
}

function mergeAndSortSteps(
  related: TraceStep[],
  currentSampleId: string,
  currentPreview: string | null | undefined,
  currentStartedAt: string | null | undefined,
): TraceStep[] {
  const hasCurrent = related.some((r) => r.id === currentSampleId)
  const all: TraceStep[] = hasCurrent
    ? related
    : [
        ...related,
        {
          id: currentSampleId,
          preview: currentPreview ?? null,
          started_at: currentStartedAt ?? null,
        },
      ]
  return all.slice().sort((a, b) => compareStartedAt(a.started_at, b.started_at))
}

function compareStartedAt(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : a > b ? 1 : 0
}

function Step({
  step,
  index,
  total,
  active,
  onClick,
}: {
  step: TraceStep
  index: number
  total: number
  active: boolean
  onClick: () => void
}): ReactNode {
  return (
    <li className="flex min-w-0 flex-1 items-stretch">
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'step' : undefined}
        className={
          'group flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1 text-left ' +
          (active
            ? 'rounded bg-forest/10 text-text-dark'
            : 'rounded text-text-mid hover:bg-warm/40 hover:text-text-dark')
        }
      >
        <span
          aria-hidden="true"
          className={
            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] ' +
            (active
              ? 'bg-forest text-cream'
              : 'border border-warm bg-cream text-text-muted')
          }
        >
          {index + 1}
        </span>
        <span className="min-w-0 truncate">
          {step.preview ?? <span className="italic text-text-muted">(no preview)</span>}
        </span>
      </button>
      {index < total - 1 && (
        <span aria-hidden="true" className="flex shrink-0 items-center px-0.5 text-text-muted">
          →
        </span>
      )}
    </li>
  )
}
