/**
 * Traces — list + detail.
 *
 * Spec: gravel-cloud/docs/spec/dashboard.md §5 (`/traces`, `/traces/:id`).
 * Calls `GET /api/traces`, `GET /api/traces/:id`, `POST /api/traces/:id/feedback`.
 */
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'wouter'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  type FeedbackItem,
  type Observation,
  type TraceDetailResponse,
  type TraceListItem,
  type TraceStatus,
  type TracesResponse,
  type DatasetsResponse,
  type DatasetSummary,
} from '../lib/types'
import { EmptyState } from '../components/EmptyState'
import { DeveloperNote } from '../components/DeveloperNote'
import { SkeletonTable, SkeletonText } from '../components/Skeleton'
import { Badge } from '../components/Badge'
import { Modal } from '../components/Modal'
import { cx, formatDuration, formatRelative, formatTokens } from '../lib/format'

const PAGE_SIZE = 20

interface TraceFilters {
  env: string
  model: string
  status: '' | TraceStatus
  q: string
  from: string
  to: string
  page: number
}

function defaultFilters(): TraceFilters {
  return { env: '', model: '', status: '', q: '', from: '', to: '', page: 1 }
}

function buildTracesQueryString(f: TraceFilters): string {
  const params = new URLSearchParams()
  if (f.env) params.set('env', f.env)
  if (f.model) params.set('model', f.model)
  if (f.status) params.set('status', f.status)
  if (f.q) params.set('q', f.q)
  if (f.from) params.set('from', f.from)
  if (f.to) params.set('to', f.to)
  params.set('page', String(f.page))
  params.set('page_size', String(PAGE_SIZE))
  return params.toString()
}

export function TracesPage({ traceId }: { traceId?: string } = {}) {
  if (traceId) return <TraceDetail traceId={traceId} />
  return <TracesList />
}

// ---------- List ----------

function TracesList() {
  const [filters, setFilters] = useState<TraceFilters>(defaultFilters())
  const queryString = buildTracesQueryString(filters)
  const path = `/api/traces?${queryString}`

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<TracesResponse>({
    queryKey: ['traces', queryString],
    queryFn: () => api.get<TracesResponse>(path),
  })

  function update<K extends keyof TraceFilters>(key: K, value: TraceFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value, page: key === 'page' ? (value as number) : 1 }))
  }

  const traces = data?.traces ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text-dark">Traces</h1>
          <p className="mt-1 text-sm text-text-mid">
            Auto-captured LLM calls. Click a row to label corrections + add to a dataset.
          </p>
        </div>
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-warm px-3 py-1.5 text-sm text-text-mid hover:bg-warm"
          onClick={() => refetch()}
          aria-label="Refresh"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <TracesFilters filters={filters} onChange={update} />

      {isError ? (
        <ErrorBox message={(error as Error)?.message ?? 'Failed to load traces.'} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="rounded-2xl border border-warm bg-cream p-4">
          <SkeletonTable rows={6} cols={6} />
        </div>
      ) : traces.length === 0 ? (
        <div className="space-y-3">
          <EmptyState
            title="No traces yet"
            body="Once the app sees traffic, traces will appear here so you can review and label them."
          />
          <DeveloperNote>
            Traces flow in once the app runs with Gravel tracing on. To diagnose, run{' '}
            <code className="rounded bg-cream px-1 py-0.5 font-mono text-[11px]">
              npx @artanis-ai/gravel doctor
            </code>
            .
          </DeveloperNote>
        </div>
      ) : (
        <TracesTable traces={traces} />
      )}

      {!isLoading && !isError && total > 0 && (
        <Pagination
          page={filters.page}
          totalPages={totalPages}
          total={total}
          onChange={(page) => update('page', page)}
        />
      )}
    </div>
  )
}

function TracesFilters({
  filters,
  onChange,
}: {
  filters: TraceFilters
  onChange: <K extends keyof TraceFilters>(key: K, value: TraceFilters[K]) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-3 rounded-2xl border border-warm bg-cream p-4 sm:grid-cols-2 lg:grid-cols-6">
      <Field label="Environment">
        <input
          type="text"
          value={filters.env}
          placeholder="prod"
          onChange={(e) => onChange('env', e.target.value)}
          aria-label="Filter by environment"
          className="w-full rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>
      <Field label="Model">
        <input
          type="text"
          value={filters.model}
          placeholder="gpt-4o"
          onChange={(e) => onChange('model', e.target.value)}
          aria-label="Filter by model"
          className="w-full rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>
      <Field label="Status">
        <select
          value={filters.status}
          onChange={(e) => onChange('status', e.target.value as TraceFilters['status'])}
          aria-label="Filter by status"
          className="w-full cursor-pointer rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">All</option>
          <option value="completed">Completed</option>
          <option value="errored">Errored</option>
          <option value="running">Running</option>
        </select>
      </Field>
      <Field label="Search">
        <input
          type="search"
          value={filters.q}
          placeholder="prompt text…"
          onChange={(e) => onChange('q', e.target.value)}
          aria-label="Search traces"
          className="w-full rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>
      <Field label="From">
        <input
          type="date"
          value={filters.from}
          onChange={(e) => onChange('from', e.target.value)}
          aria-label="Filter from date"
          className="w-full cursor-pointer rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>
      <Field label="To">
        <input
          type="date"
          value={filters.to}
          onChange={(e) => onChange('to', e.target.value)}
          aria-label="Filter to date"
          className="w-full cursor-pointer rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-text-mid">
      {label}
      {children}
    </label>
  )
}

function TracesTable({ traces }: { traces: TraceListItem[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-warm bg-cream">
      <table className="w-full text-sm">
        <thead className="bg-warm/40 text-xs uppercase tracking-wide text-text-mid">
          <tr>
            <th className="px-4 py-2 text-left font-medium">When</th>
            <th className="px-4 py-2 text-left font-medium">Name</th>
            <th className="px-4 py-2 text-left font-medium">Model</th>
            <th className="px-4 py-2 text-right font-medium">Tokens (in / out)</th>
            <th className="px-4 py-2 text-right font-medium">Duration</th>
            <th className="px-4 py-2 text-left font-medium">Status</th>
            <th className="px-4 py-2 text-left font-medium">Feedback</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <TraceRow key={t.id} trace={t} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TraceRow({ trace }: { trace: TraceListItem }) {
  return (
    <tr className="border-t border-warm hover:bg-warm/30">
      <td className="px-4 py-2 text-text-mid">
        <Link
          href={`/traces/${trace.id}`}
          className="cursor-pointer text-text-dark hover:underline"
          data-testid={`trace-link-${trace.id}`}
        >
          {formatRelative(trace.started_at)}
        </Link>
      </td>
      <td className="px-4 py-2 font-mono text-xs text-text-dark">{trace.name}</td>
      <td className="px-4 py-2 font-mono text-xs text-text-mid">{trace.model ?? '—'}</td>
      <td className="px-4 py-2 text-right font-mono text-xs text-text-mid">
        {formatTokens(trace.tokens_in)} / {formatTokens(trace.tokens_out)}
      </td>
      <td className="px-4 py-2 text-right font-mono text-xs text-text-mid">{formatDuration(trace.duration_ms)}</td>
      <td className="px-4 py-2"><StatusBadge status={trace.status} /></td>
      <td className="px-4 py-2"><FeedbackBadge trace={trace} /></td>
    </tr>
  )
}

function StatusBadge({ status }: { status: TraceStatus }) {
  if (status === 'completed') return <Badge tone="good" icon="✓">ok</Badge>
  if (status === 'errored') return <Badge tone="bad" icon="✕">error</Badge>
  return <Badge tone="info" icon="●">running</Badge>
}

function FeedbackBadge({ trace }: { trace: TraceListItem }) {
  if (trace.feedback_count === 0) return <span className="text-xs text-text-muted">—</span>
  if (trace.feedback_score === 'positive') return <Badge tone="good" icon="↑">{trace.feedback_count}</Badge>
  if (trace.feedback_score === 'negative') return <Badge tone="bad" icon="↓">{trace.feedback_count}</Badge>
  return <Badge tone="warn" icon="•">{trace.feedback_count}</Badge>
}

function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number
  totalPages: number
  total: number
  onChange: (page: number) => void
}) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between text-xs text-text-mid">
      <div>
        Page <span className="font-medium text-text-dark">{page}</span> of{' '}
        <span className="font-medium text-text-dark">{totalPages}</span> · {total.toLocaleString()} traces
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className={cx(
            'rounded-md border border-warm px-2 py-1',
            page <= 1 ? 'cursor-not-allowed text-text-muted' : 'cursor-pointer hover:bg-warm',
          )}
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          ← Prev
        </button>
        <button
          type="button"
          className={cx(
            'rounded-md border border-warm px-2 py-1',
            page >= totalPages ? 'cursor-not-allowed text-text-muted' : 'cursor-pointer hover:bg-warm',
          )}
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          Next →
        </button>
      </div>
    </nav>
  )
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-sm text-primary-dark">
      <p className="font-medium">Failed to load.</p>
      <p className="mt-1 font-mono text-xs">{message}</p>
      <button
        type="button"
        className="mt-3 cursor-pointer rounded-md border border-primary/30 px-2 py-1 text-xs hover:bg-primary/10"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  )
}

// ---------- Detail ----------

function TraceDetail({ traceId }: { traceId: string }) {
  const path = `/api/traces/${traceId}`
  const { data, isLoading, isError, error } = useQuery<TraceDetailResponse>({
    queryKey: ['trace', traceId],
    queryFn: () => api.get<TraceDetailResponse>(path),
  })

  const [addOpen, setAddOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="space-y-6">
        <SkeletonText lines={2} />
        <div className="rounded-2xl border border-warm bg-cream p-4">
          <SkeletonText lines={6} />
        </div>
      </div>
    )
  }
  if (isError || !data) {
    return (
      <ErrorBox
        message={(error as Error)?.message ?? 'Trace not found.'}
        onRetry={() => window.location.reload()}
      />
    )
  }

  const { trace, observations, feedback } = data

  return (
    <div className="space-y-6">
      <div>
        <Link href="/traces" className="cursor-pointer text-xs text-text-mid hover:text-text-dark">
          ← All traces
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-4">
          <h1 className="font-display text-2xl font-semibold text-text-dark">
            {trace.name}{' '}
            <span className="font-mono text-sm font-normal text-text-muted">{trace.id}</span>
          </h1>
          <button
            type="button"
            className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
            onClick={() => setAddOpen(true)}
          >
            Add to dataset
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-text-mid sm:grid-cols-5">
          <Stat label="Started" value={formatRelative(trace.started_at)} />
          <Stat label="Duration" value={formatDuration(trace.duration_ms)} />
          <Stat label="Model" value={trace.model ?? '—'} mono />
          <Stat label="Status" value={<StatusBadge status={trace.status} />} />
          <Stat label="Env" value={trace.environment ?? '—'} />
        </div>
      </div>

      <ObservationsTimeline observations={observations} />
      <FeedbackPanel traceId={trace.id} feedback={feedback} />

      <AddToDatasetModal traceId={trace.id} open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}

function Stat({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-text-muted">{label}</div>
      <div className={cx('mt-0.5 text-text-dark', mono && 'font-mono')}>{value}</div>
    </div>
  )
}

function ObservationsTimeline({ observations }: { observations: Observation[] }) {
  const sorted = useMemo(
    () =>
      [...observations].sort((a, b) => {
        const at = new Date(a.started_at ?? a.timestamp).getTime()
        const bt = new Date(b.started_at ?? b.timestamp).getTime()
        return at - bt
      }),
    [observations],
  )

  if (sorted.length === 0) {
    return (
      <section className="rounded-2xl border border-warm bg-cream p-4 text-sm text-text-mid">
        No observations on this trace.
      </section>
    )
  }

  return (
    <section className="space-y-3">
      <h2 className="font-display text-lg font-semibold text-text-dark">Observations</h2>
      <ol className="space-y-2">
        {sorted.map((obs) => (
          <ObservationItem key={obs.id} obs={obs} />
        ))}
      </ol>
    </section>
  )
}

function ObservationItem({ obs }: { obs: Observation }) {
  const [open, setOpen] = useState(obs.type === 'input' || obs.type === 'output')
  const json = useMemo(() => safeJsonString(obs.data), [obs.data])
  const tone =
    obs.type === 'input' ? 'info' : obs.type === 'output' ? 'good' : 'neutral'

  return (
    <li className="overflow-hidden rounded-xl border border-warm bg-cream">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-2 text-left hover:bg-warm/40"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <Badge tone={tone}>{obs.type}</Badge>
          <span className="text-sm text-text-dark">{obs.name ?? obs.key ?? '—'}</span>
        </span>
        <span className="text-xs text-text-muted">
          {formatRelative(obs.started_at ?? obs.timestamp)} · {open ? 'collapse' : 'expand'}
        </span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto border-t border-warm bg-white px-4 py-2 font-mono text-xs text-text-dark">
          {json}
        </pre>
      )}
    </li>
  )
}

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function FeedbackPanel({ traceId, feedback }: { traceId: string; feedback: FeedbackItem[] }) {
  const queryClient = useQueryClient()
  const [thumbs, setThumbs] = useState<'up' | 'down' | null>(null)
  const [comment, setComment] = useState('')
  const [correction, setCorrection] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const submit = useMutation<unknown, Error, void>({
    mutationFn: () =>
      api.post(`/api/traces/${traceId}/feedback`, {
        thumbs,
        comment: comment || null,
        correction: correction || null,
      }),
    onSuccess: () => {
      setThumbs(null)
      setComment('')
      setCorrection('')
      setFormError(null)
      queryClient.invalidateQueries({ queryKey: ['trace', traceId] })
    },
    onError: (err) => setFormError(err.message),
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!thumbs) {
      setFormError('Pick thumbs up or thumbs down first.')
      return
    }
    submit.mutate()
  }

  return (
    <section className="space-y-3">
      <h2 className="font-display text-lg font-semibold text-text-dark">Feedback</h2>
      {feedback.length === 0 ? (
        <p className="text-sm text-text-mid">No feedback yet — be the first to label this one.</p>
      ) : (
        <ul className="space-y-2">
          {feedback.map((f) => (
            <li key={f.id} className="rounded-xl border border-warm bg-cream p-3 text-sm">
              <div className="flex items-center gap-2 text-xs text-text-mid">
                <Badge tone={f.score === 'positive' ? 'good' : f.score === 'negative' ? 'bad' : 'neutral'}>
                  {f.score === 'positive' ? '↑ thumbs up' : f.score === 'negative' ? '↓ thumbs down' : 'neutral'}
                </Badge>
                <span>{formatRelative(f.created_at)}</span>
              </div>
              {f.comment && <p className="mt-2 text-text-dark">{f.comment}</p>}
              {f.correction && (
                <pre className="mt-2 whitespace-pre-wrap rounded-md bg-white p-2 font-mono text-xs text-text-dark">
                  {f.correction}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={onSubmit}
        className="space-y-3 rounded-2xl border border-warm bg-cream p-4"
        aria-label="Add feedback"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={thumbs === 'up'}
            aria-label="Thumbs up"
            className={cx(
              'cursor-pointer rounded-lg border px-3 py-1.5 text-sm',
              thumbs === 'up' ? 'border-forest bg-forest/15 text-forest' : 'border-warm hover:bg-warm',
            )}
            onClick={() => setThumbs('up')}
          >
            ↑ Thumbs up
          </button>
          <button
            type="button"
            aria-pressed={thumbs === 'down'}
            aria-label="Thumbs down"
            className={cx(
              'cursor-pointer rounded-lg border px-3 py-1.5 text-sm',
              thumbs === 'down' ? 'border-primary bg-primary/15 text-primary-dark' : 'border-warm hover:bg-warm',
            )}
            onClick={() => setThumbs('down')}
          >
            ↓ Thumbs down
          </button>
        </div>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why was this good or bad?"
          aria-label="Comment"
          className="w-full rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          rows={2}
        />
        <textarea
          value={correction}
          onChange={(e) => setCorrection(e.target.value)}
          placeholder="What should the output have been? (used as eval ground truth)"
          aria-label="Correction"
          className="w-full rounded-md border border-warm bg-white px-2 py-1 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
          rows={3}
        />
        {formError && <p className="text-xs text-primary-dark">{formError}</p>}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submit.isPending}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium text-white',
              submit.isPending ? 'cursor-not-allowed bg-primary/60' : 'cursor-pointer bg-primary hover:bg-primary-dark',
            )}
          >
            {submit.isPending ? 'Saving…' : 'Save feedback'}
          </button>
        </div>
      </form>
    </section>
  )
}

function AddToDatasetModal({ traceId, open, onClose }: { traceId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery<DatasetsResponse>({
    queryKey: ['datasets'],
    queryFn: () => api.get<DatasetsResponse>('/api/datasets'),
    enabled: open,
  })
  const [selected, setSelected] = useState<string | null>(null)

  const add = useMutation<unknown, Error, string>({
    mutationFn: (datasetId) => api.post(`/api/datasets/${datasetId}/traces`, { trace_ids: [traceId] }),
    onSuccess: (_d, datasetId) => {
      queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] })
      onClose()
    },
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add to dataset"
      footer={
        <>
          <button
            type="button"
            className="cursor-pointer rounded-lg border border-warm px-3 py-1.5 text-sm hover:bg-warm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected || add.isPending}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium text-white',
              !selected || add.isPending
                ? 'cursor-not-allowed bg-primary/60'
                : 'cursor-pointer bg-primary hover:bg-primary-dark',
            )}
            onClick={() => selected && add.mutate(selected)}
          >
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    >
      {isLoading ? (
        <SkeletonText lines={3} />
      ) : !data || data.datasets.length === 0 ? (
        <p className="text-sm text-text-mid">
          No datasets yet. Create one from the{' '}
          <Link href="/datasets" className="cursor-pointer underline">Datasets</Link> page first.
        </p>
      ) : (
        <ul className="space-y-1">
          {data.datasets.map((d: DatasetSummary) => (
            <li key={d.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-warm">
                <input
                  type="radio"
                  name="dataset"
                  value={d.id}
                  checked={selected === d.id}
                  onChange={() => setSelected(d.id)}
                  className="cursor-pointer"
                />
                <span className="text-sm text-text-dark">{d.name}</span>
                <span className="text-xs text-text-muted">{d.trace_count} traces</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {add.isError && <p className="mt-3 text-xs text-primary-dark">{add.error.message}</p>}
    </Modal>
  )
}
