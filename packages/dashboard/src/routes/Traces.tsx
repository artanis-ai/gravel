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
import { CopyableCode } from '../components/CopyableCode'
import { SkeletonTable, SkeletonText } from '../components/Skeleton'
import { Badge } from '../components/Badge'
import { Modal } from '../components/Modal'
import { Sheet } from '../components/Sheet'
import { cx, formatDuration, formatRelative, formatTokens } from '../lib/format'

const PAGE_SIZE = 20

type SortKey = 'started_at' | 'duration_ms' | 'tokens_in' | 'tokens_out' | 'feedback_count'
type SortDir = 'asc' | 'desc'

interface TraceFilters {
  env: string
  model: string
  status: '' | TraceStatus
  q: string
  from: string
  to: string
  page: number
  sortBy: SortKey
  sortDir: SortDir
}

function defaultFilters(): TraceFilters {
  return { env: '', model: '', status: '', q: '', from: '', to: '', page: 1, sortBy: 'started_at', sortDir: 'desc' }
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
  const [sheetTraceId, setSheetTraceId] = useState<string | null>(null)
  const queryString = buildTracesQueryString(filters)
  const path = `/api/traces?${queryString}`

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<TracesResponse>({
    queryKey: ['traces', queryString],
    queryFn: () => api.get<TracesResponse>(path),
  })

  function update<K extends keyof TraceFilters>(key: K, value: TraceFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value, page: key === 'page' ? (value as number) : 1 }))
  }

  function toggleSort(key: SortKey) {
    setFilters((prev) => ({
      ...prev,
      sortBy: key,
      sortDir: prev.sortBy === key && prev.sortDir === 'desc' ? 'asc' : 'desc',
      page: 1,
    }))
  }

  const tracesUnsorted = data?.traces ?? []
  const traces = useMemo(() => sortClientSide(tracesUnsorted, filters.sortBy, filters.sortDir), [
    tracesUnsorted,
    filters.sortBy,
    filters.sortDir,
  ])
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const startIndex = total === 0 ? 0 : (filters.page - 1) * PAGE_SIZE + 1
  const endIndex = Math.min(filters.page * PAGE_SIZE, total)

  return (
    <div className="space-y-4">
      <DeveloperNote>
        Traces flow in once the app runs with Gravel tracing on. To diagnose, run{' '}
        <CopyableCode>npx @artanis-ai/gravel doctor</CopyableCode>
        .
      </DeveloperNote>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <TracesFilters filters={filters} onChange={update} />
        </div>
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded-lg border border-warm bg-cream p-2 text-text-mid hover:bg-warm"
          onClick={() => refetch()}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshIcon spinning={isFetching} />
        </button>
      </div>

      {isError ? (
        <ErrorBox message={(error as Error)?.message ?? 'Failed to load traces.'} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="rounded-lg border border-warm bg-cream p-4">
          <SkeletonTable rows={8} cols={7} />
        </div>
      ) : traces.length === 0 ? (
        <EmptyState
          title="No outputs yet"
          body="Once your app produces AI output, it'll appear here so you can flag any that need a closer look."
        />
      ) : (
        <TracesTable
          traces={traces}
          sortBy={filters.sortBy}
          sortDir={filters.sortDir}
          onSort={toggleSort}
          onRowClick={(t) => setSheetTraceId(t.id)}
        />
      )}

      {!isLoading && !isError && total > 0 && (
        <PaginationBar
          page={filters.page}
          totalPages={totalPages}
          startIndex={startIndex}
          endIndex={endIndex}
          total={total}
          onChange={(page) => update('page', page)}
        />
      )}

      <Sheet
        open={sheetTraceId !== null}
        onClose={() => setSheetTraceId(null)}
        title={sheetTraceId ? <SheetTitle traceId={sheetTraceId} /> : 'Output'}
        subtitle={
          sheetTraceId ? (
            <Link
              href={`/traces/${sheetTraceId}`}
              className="cursor-pointer underline hover:text-text-dark"
            >
              Open full page
            </Link>
          ) : undefined
        }
      >
        {sheetTraceId && <TraceDetailBody traceId={sheetTraceId} />}
      </Sheet>
    </div>
  )
}

function SheetTitle({ traceId }: { traceId: string }) {
  // Read straight from the cached query — avoids a second fetch.
  const { data } = useQuery<TraceDetailResponse>({
    queryKey: ['trace', traceId],
    queryFn: () => api.get<TraceDetailResponse>(`/api/traces/${traceId}`),
  })
  return <span className="font-mono text-sm font-medium">{data?.trace.name ?? 'Output'}</span>
}

/**
 * Client-side sort over the current page. Keeps the implementation
 * small for v0; once real sort filters land server-side, wire `sortBy`
 * + `sortDir` into the query string + drop this helper.
 */
function sortClientSide(rows: TraceListItem[], key: SortKey, dir: SortDir): TraceListItem[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (key === 'started_at') {
      return (Date.parse(a.started_at) - Date.parse(b.started_at)) * sign
    }
    const av = (a[key] ?? 0) as number
    const bv = (b[key] ?? 0) as number
    return (av - bv) * sign
  })
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
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
      aria-hidden="true"
      className={spinning ? 'animate-spin' : ''}
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
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

function TracesTable({
  traces,
  sortBy,
  sortDir,
  onSort,
  onRowClick,
}: {
  traces: TraceListItem[]
  sortBy: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  onRowClick: (t: TraceListItem) => void
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-warm bg-cream">
      <table className="w-full text-sm">
        <thead className="border-b border-warm bg-warm/30 text-[11px] uppercase tracking-wide text-text-mid">
          <tr>
            <SortHeader label="When" col="started_at" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
            <th className="px-4 py-2 text-left font-medium">Name</th>
            <th className="px-4 py-2 text-left font-medium">Model</th>
            <th className="px-4 py-2 text-left font-medium">Env</th>
            <SortHeader label="Tokens" col="tokens_in" sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Duration" col="duration_ms" sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right" />
            <th className="px-4 py-2 text-left font-medium">Status</th>
            <SortHeader label="Feedback" col="feedback_count" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <TraceRow key={t.id} trace={t} onClick={() => onRowClick(t)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SortHeader({
  label,
  col,
  sortBy,
  sortDir,
  onSort,
  align = 'left',
}: {
  label: string
  col: SortKey
  sortBy: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  align?: 'left' | 'right'
}) {
  const active = sortBy === col
  return (
    <th className={`px-4 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex cursor-pointer items-center gap-1 ${
          active ? 'text-text-dark' : 'hover:text-text-dark'
        }`}
      >
        {label}
        <SortGlyph active={active} dir={sortDir} />
      </button>
    </th>
  )
}

function SortGlyph({ active, dir }: { active: boolean; dir: SortDir }) {
  // Triple state: inactive (faded ↕), active asc (↑), active desc (↓).
  const path = !active
    ? 'M7 10l5-5 5 5M7 14l5 5 5-5'
    : dir === 'asc'
      ? 'M5 15l7-7 7 7'
      : 'M19 9l-7 7-7-7'
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={active ? 'opacity-100' : 'opacity-30'}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}

function TraceRow({ trace, onClick }: { trace: TraceListItem; onClick: () => void }) {
  return (
    <tr
      className="cursor-pointer border-t border-warm/60 hover:bg-warm/40"
      onClick={onClick}
      data-testid={`trace-row-${trace.id}`}
    >
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-mid">{formatRelative(trace.started_at)}</td>
      <td className="px-4 py-2 font-mono text-xs text-text-dark">{trace.name}</td>
      <td className="px-4 py-2 font-mono text-xs text-text-mid">{trace.model ?? '—'}</td>
      <td className="px-4 py-2 text-xs text-text-mid">{trace.environment ?? '—'}</td>
      <td className="whitespace-nowrap px-4 py-2 text-right font-mono text-xs text-text-mid">
        {formatTokens(trace.tokens_in)} / {formatTokens(trace.tokens_out)}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-right font-mono text-xs text-text-mid">
        {formatDuration(trace.duration_ms)}
      </td>
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

/**
 * Bottom pagination bar matching the platform's pattern: count caption
 * on the left, prev/page-numbers/next on the right. Renders a small
 * window of pages around `page` with ellipses for the rest.
 */
function PaginationBar({
  page,
  totalPages,
  startIndex,
  endIndex,
  total,
  onChange,
}: {
  page: number
  totalPages: number
  startIndex: number
  endIndex: number
  total: number
  onChange: (page: number) => void
}) {
  const pages: (number | 'gap')[] = []
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= page - 1 && p <= page + 1)) {
      pages.push(p)
    } else if (pages[pages.length - 1] !== 'gap') {
      pages.push('gap')
    }
  }
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-mid">
      <p className="text-text-mid">
        Showing <span className="font-medium text-text-dark">{startIndex}</span>–
        <span className="font-medium text-text-dark">{endIndex}</span> of{' '}
        <span className="font-medium text-text-dark">{total.toLocaleString()}</span>
      </p>
      {totalPages > 1 && (
        <ul className="flex items-center gap-1">
          <li>
            <PageButton disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page">
              ‹
            </PageButton>
          </li>
          {pages.map((p, i) =>
            p === 'gap' ? (
              <li key={`gap-${i}`} className="px-1 text-text-muted">
                …
              </li>
            ) : (
              <li key={p}>
                <PageButton active={p === page} onClick={() => onChange(p)} aria-label={`Page ${p}`}>
                  {p}
                </PageButton>
              </li>
            ),
          )}
          <li>
            <PageButton
              disabled={page >= totalPages}
              onClick={() => onChange(page + 1)}
              aria-label="Next page"
            >
              ›
            </PageButton>
          </li>
        </ul>
      )}
    </nav>
  )
}

function PageButton({
  children,
  onClick,
  active,
  disabled,
  ...rest
}: {
  children: React.ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-md px-2 text-xs',
        active
          ? 'bg-text-dark text-cream'
          : disabled
            ? 'cursor-not-allowed text-text-muted'
            : 'cursor-pointer text-text-mid hover:bg-warm',
      )}
      {...rest}
    >
      {children}
    </button>
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

/**
 * Full-page trace detail (`/traces/:id`). Used for direct links / new
 * tab opens. The Outputs list opens the same content in a side sheet
 * via TraceDetailBody so the DE doesn't lose context.
 */
function TraceDetail({ traceId }: { traceId: string }) {
  return (
    <div className="space-y-6">
      <Link href="/traces" className="cursor-pointer text-xs text-text-mid hover:text-text-dark">
        ← Back to outputs
      </Link>
      <TraceDetailBody traceId={traceId} showTitle />
    </div>
  )
}

function TraceDetailBody({ traceId, showTitle = false }: { traceId: string; showTitle?: boolean }) {
  const path = `/api/traces/${traceId}`
  const { data, isLoading, isError, error } = useQuery<TraceDetailResponse>({
    queryKey: ['trace', traceId],
    queryFn: () => api.get<TraceDetailResponse>(path),
  })

  const [addOpen, setAddOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="space-y-4">
        <SkeletonText lines={2} />
        <div className="rounded-lg border border-warm bg-cream p-4">
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
    <div className="space-y-5">
      {showTitle && (
        <div className="flex items-baseline justify-between gap-4">
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
      )}
      <div className="grid grid-cols-2 gap-3 text-xs text-text-mid sm:grid-cols-5">
        <Stat label="Started" value={formatRelative(trace.started_at)} />
        <Stat label="Duration" value={formatDuration(trace.duration_ms)} />
        <Stat label="Model" value={trace.model ?? '—'} mono />
        <Stat label="Status" value={<StatusBadge status={trace.status} />} />
        <Stat label="Env" value={trace.environment ?? '—'} />
      </div>

      {!showTitle && (
        <button
          type="button"
          className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
          onClick={() => setAddOpen(true)}
        >
          Add to dataset
        </button>
      )}

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
