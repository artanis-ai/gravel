/**
 * Outputs — list + detail. The dashboard tab the domain expert lands on
 * to look at AI calls; the tab label is "Outputs", the route is
 * /samples, and each row in the list is one sample (one input/output
 * exchange). A multi-step trace is samples sharing a group_id.
 *
 * Spec: gravel-cloud/docs/spec/dashboard.md §5.
 * Calls `GET /api/samples`, `GET /api/samples/:id`, `POST /api/samples/:id/feedback`.
 */
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'wouter'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  type FeedbackItem,
  type SampleDetailResponse,
  type SampleListItem,
  type SampleStatus,
  type SamplesResponse,
} from '../lib/types'
import { EmptyState } from '../components/EmptyState'
import { DeveloperNote } from '../components/DeveloperNote'
import { CopyableCode } from '../components/CopyableCode'
import { PayloadShape } from '../components/PayloadShape'
import { SkeletonTable, SkeletonText } from '../components/Skeleton'
import { Badge } from '../components/Badge'
import { Sheet } from '../components/Sheet'
import { cx, formatDuration, formatRelative, formatTokens } from '../lib/format'

const PAGE_SIZE = 20

type SortKey = 'started_at' | 'duration_ms' | 'tokens_in' | 'tokens_out' | 'feedback_count'
type SortDir = 'asc' | 'desc'

interface SampleFilters {
  env: string
  model: string
  status: '' | SampleStatus
  q: string
  from: string
  to: string
  page: number
  sortBy: SortKey
  sortDir: SortDir
}

function defaultFilters(): SampleFilters {
  return { env: '', model: '', status: '', q: '', from: '', to: '', page: 1, sortBy: 'started_at', sortDir: 'desc' }
}

function buildTracesQueryString(f: SampleFilters): string {
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

export function SamplesPage({ sampleId }: { sampleId?: string } = {}) {
  if (sampleId) return <SampleDetail sampleId={sampleId} />
  return <SamplesList />
}

// ---------- List ----------

function SamplesList() {
  const [filters, setFilters] = useState<SampleFilters>(defaultFilters())
  const [sheetSampleId, setSheetSampleId] = useState<string | null>(null)
  const queryString = buildTracesQueryString(filters)
  const path = `/api/samples?${queryString}`

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<SamplesResponse>({
    queryKey: ['samples', queryString],
    queryFn: () => api.get<SamplesResponse>(path),
  })

  function update<K extends keyof SampleFilters>(key: K, value: SampleFilters[K]) {
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

  const samplesUnsorted = data?.samples ?? []
  const samples = useMemo(() => sortClientSide(samplesUnsorted, filters.sortBy, filters.sortDir), [
    samplesUnsorted,
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
        Outputs flow in once the app runs with Gravel tracing on. To diagnose, run{' '}
        <CopyableCode>npx @artanis-ai/gravel doctor</CopyableCode>
        .
      </DeveloperNote>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <SamplesFilters filters={filters} onChange={update} />
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
        <ErrorBox message={(error as Error)?.message ?? 'Failed to load outputs.'} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="rounded-lg border border-warm bg-cream p-4">
          <SkeletonTable rows={8} cols={7} />
        </div>
      ) : samples.length === 0 ? (
        <EmptyState
          title="No outputs yet"
          body="Once your app produces AI output, it'll appear here so you can flag any that need a closer look."
        />
      ) : (
        <SamplesTable
          samples={samples}
          sortBy={filters.sortBy}
          sortDir={filters.sortDir}
          onSort={toggleSort}
          onRowClick={(t) => setSheetSampleId(t.id)}
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
        open={sheetSampleId !== null}
        onClose={() => setSheetSampleId(null)}
        title={sheetSampleId ? <SheetTitle sampleId={sheetSampleId} /> : 'Output'}
        subtitle={
          sheetSampleId ? (
            <Link
              href={`/samples/${sheetSampleId}`}
              className="cursor-pointer underline hover:text-text-dark"
            >
              Open full page
            </Link>
          ) : undefined
        }
      >
        {sheetSampleId && <SampleDetailBody sampleId={sheetSampleId} />}
      </Sheet>
    </div>
  )
}

function SheetTitle({ sampleId }: { sampleId: string }) {
  // Read straight from the cached query — avoids a second fetch.
  const { data } = useQuery<SampleDetailResponse>({
    queryKey: ['sample', sampleId],
    queryFn: () => api.get<SampleDetailResponse>(`/api/samples/${sampleId}`),
  })
  return <span className="font-mono text-sm font-medium">{data?.sample.name ?? 'Output'}</span>
}

/**
 * Client-side sort over the current page. Keeps the implementation
 * small for v0; once real sort filters land server-side, wire `sortBy`
 * + `sortDir` into the query string + drop this helper.
 */
function sortClientSide(rows: SampleListItem[], key: SortKey, dir: SortDir): SampleListItem[] {
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

function SamplesFilters({
  filters,
  onChange,
}: {
  filters: SampleFilters
  onChange: <K extends keyof SampleFilters>(key: K, value: SampleFilters[K]) => void
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
          onChange={(e) => onChange('status', e.target.value as SampleFilters['status'])}
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
          aria-label="Search outputs"
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

function SamplesTable({
  samples,
  sortBy,
  sortDir,
  onSort,
  onRowClick,
}: {
  samples: SampleListItem[]
  sortBy: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  onRowClick: (t: SampleListItem) => void
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
          {samples.map((s) => (
            <SampleRow key={s.id} sample={s} onClick={() => onRowClick(s)} />
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

function SampleRow({ sample, onClick }: { sample: SampleListItem; onClick: () => void }) {
  return (
    <tr
      className="cursor-pointer border-t border-warm/60 hover:bg-warm/40"
      onClick={onClick}
      data-testid={`sample-row-${sample.id}`}
    >
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-mid">{formatRelative(sample.started_at)}</td>
      <td className="px-4 py-2 font-mono text-xs text-text-dark">{sample.name}</td>
      <td className="px-4 py-2 font-mono text-xs text-text-mid">{sample.model ?? '—'}</td>
      <td className="px-4 py-2 text-xs text-text-mid">{sample.environment ?? '—'}</td>
      <td className="whitespace-nowrap px-4 py-2 text-right font-mono text-xs text-text-mid">
        {formatTokens(sample.tokens_in)} / {formatTokens(sample.tokens_out)}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-right font-mono text-xs text-text-mid">
        {formatDuration(sample.duration_ms)}
      </td>
      <td className="px-4 py-2"><StatusBadge status={sample.status} /></td>
      <td className="px-4 py-2"><FeedbackBadge sample={sample} /></td>
    </tr>
  )
}

function StatusBadge({ status }: { status: SampleStatus }) {
  if (status === 'completed') return <Badge tone="good" icon="✓">ok</Badge>
  if (status === 'errored') return <Badge tone="bad" icon="✕">error</Badge>
  return <Badge tone="info" icon="●">running</Badge>
}

function FeedbackBadge({ sample }: { sample: SampleListItem }) {
  if (sample.feedback_count === 0) return <span className="text-xs text-text-muted">—</span>
  if (sample.feedback_score === 'positive') return <Badge tone="good" icon="↑">{sample.feedback_count}</Badge>
  if (sample.feedback_score === 'negative') return <Badge tone="bad" icon="↓">{sample.feedback_count}</Badge>
  return <Badge tone="warn" icon="•">{sample.feedback_count}</Badge>
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
 * Full-page trace detail (`/samples/:id`). Used for direct links / new
 * tab opens. The Outputs list opens the same content in a side sheet
 * via SampleDetailBody so the DE doesn't lose context.
 */
function SampleDetail({ sampleId }: { sampleId: string }) {
  return (
    <div className="space-y-6">
      <Link href="/samples" className="cursor-pointer text-xs text-text-mid hover:text-text-dark">
        ← Back to outputs
      </Link>
      <SampleDetailBody sampleId={sampleId} showTitle />
    </div>
  )
}

function SampleDetailBody({ sampleId, showTitle = false }: { sampleId: string; showTitle?: boolean }) {
  const path = `/api/samples/${sampleId}`
  const { data, isLoading, isError, error } = useQuery<SampleDetailResponse>({
    queryKey: ['sample', sampleId],
    queryFn: () => api.get<SampleDetailResponse>(path),
  })

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
        message={(error as Error)?.message ?? 'Sample not found.'}
        onRetry={() => window.location.reload()}
      />
    )
  }

  const { sample, feedback, related } = data

  return (
    <div className="space-y-5">
      {showTitle && (
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-display text-2xl font-semibold text-text-dark">
            {sample.name}{' '}
            <span className="font-mono text-sm font-normal text-text-muted">{sample.id}</span>
          </h1>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 text-xs text-text-mid sm:grid-cols-5">
        <Stat label="Started" value={formatRelative(sample.started_at)} />
        <Stat label="Duration" value={formatDuration(sample.duration_ms)} />
        <Stat label="Model" value={sample.model ?? '—'} mono />
        <Stat label="Status" value={<StatusBadge status={sample.status} />} />
        <Stat label="Env" value={sample.environment ?? '—'} />
      </div>

      <PayloadView label="Input" value={sample.input} />
      <PayloadView label="Output" value={sample.output} />
      {sample.metadata && Object.keys(sample.metadata).length > 0 && (
        <PayloadView label="Metadata" value={sample.metadata} />
      )}

      {related.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-display text-sm font-semibold text-text-dark">
            Other steps in this trace
            <span className="ml-2 font-normal text-text-muted">{related.length}</span>
          </h2>
          <ul className="divide-y divide-warm rounded-xl border border-warm bg-cream">
            {related.map((s) => (
              <li key={s.id} className="px-3 py-2 text-sm">
                <Link
                  href={`/samples/${s.id}`}
                  className="cursor-pointer font-mono text-xs text-text-dark hover:underline"
                >
                  {s.name}
                </Link>
                <span className="ml-2 text-xs text-text-muted">
                  {formatRelative(s.started_at)} · {formatDuration(s.duration_ms)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <FeedbackPanel sampleId={sample.id} feedback={feedback} />
    </div>
  )
}

/**
 * Render a JSON-ish payload (input / output / metadata). Pretty-prints
 * objects, falls back to raw text otherwise. Collapsed-by-default for
 * very long values.
 */
function PayloadView({ label, value }: { label: string; value: unknown }) {
  const json = useMemo(() => safeJsonString(value), [value])
  const big = json.length > 4000
  const [showRaw, setShowRaw] = useState(false)
  const [open, setOpen] = useState(!big)
  if (value == null || (typeof value === 'object' && Object.keys(value as object).length === 0)) {
    return null
  }
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-sm font-semibold text-text-dark">{label}</h2>
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => setShowRaw((s) => !s)}
            className="cursor-pointer text-text-mid hover:text-text-dark"
          >
            {showRaw ? 'Pretty' : 'Raw JSON'}
          </button>
          {big && showRaw && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="cursor-pointer text-text-mid hover:text-text-dark"
            >
              {open ? 'Collapse' : 'Expand'}
            </button>
          )}
        </div>
      </div>
      {showRaw ? (
        <pre className="max-h-96 overflow-auto rounded-xl border border-warm bg-cream px-4 py-3 font-mono text-xs text-text-dark">
          {open ? json : json.slice(0, 800) + '\n…'}
        </pre>
      ) : (
        <PayloadShape value={value} />
      )}
    </section>
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

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function FeedbackPanel({ sampleId, feedback }: { sampleId: string; feedback: FeedbackItem[] }) {
  const queryClient = useQueryClient()
  const [thumbs, setThumbs] = useState<'up' | 'down' | null>(null)
  const [comment, setComment] = useState('')
  const [correction, setCorrection] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const submit = useMutation<unknown, Error, void>({
    mutationFn: () =>
      api.post(`/api/samples/${sampleId}/feedback`, {
        thumbs,
        comment: comment || null,
        correction: correction || null,
      }),
    onSuccess: () => {
      setThumbs(null)
      setComment('')
      setCorrection('')
      setFormError(null)
      queryClient.invalidateQueries({ queryKey: ['sample', sampleId] })
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

