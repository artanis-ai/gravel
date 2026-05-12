/**
 * Review tab — paginated list of AI samples + a modal reviewer for each.
 * Route is /samples (the SDK still calls them samples internally); the
 * tab label and UX is the domain expert's "Review" surface.
 *
 * Spec: gravel-cloud/docs/spec/dashboard.md §5.
 * Calls `GET /api/samples`, `GET /api/samples/:id`, `POST /api/samples/:id/feedback`.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
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
import { SampleReviewDialog } from '../components/samples/SampleReviewDialog'
import { cx, formatDuration, formatRelative, formatTokens } from '../lib/format'

const PAGE_SIZE = 20

type SortKey = 'started_at' | 'duration_ms' | 'tokens_in' | 'tokens_out' | 'feedback_count'
type SortDir = 'asc' | 'desc'

interface SampleFilters {
  /** Free-text search; the SDK matches on `name` (and any column it
   *  cares to expand later). One field, full coverage — env / model /
   *  status all live in the row text already, so a search hit on
   *  "errored" or "gpt-4o" works for the common case. */
  q: string
  from: string
  to: string
  page: number
  sortBy: SortKey
  sortDir: SortDir
}

function defaultFilters(): SampleFilters {
  return { q: '', from: '', to: '', page: 1, sortBy: 'started_at', sortDir: 'desc' }
}

function buildTracesQueryString(f: SampleFilters): string {
  const params = new URLSearchParams()
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
  // Search has its own immediate state — typing should feel instant
  // even though the network call only fires after a 250ms pause.
  const [searchInput, setSearchInput] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (searchInput !== filters.q) {
        setFilters((prev) => ({ ...prev, q: searchInput, page: 1 }))
      }
    }, 250)
    return () => window.clearTimeout(t)
    // We intentionally only depend on searchInput; checking filters.q
    // inside the timeout avoids resetting the page when other filters
    // change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])
  // Index into the current page's samples; -1 means dialog closed.
  // Index-based (vs id-based) so prev/next are O(1) array hops.
  const [reviewIndex, setReviewIndex] = useState(-1)
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

  // The Trace Evals upsell only makes sense once the user has traces
  // landing. If the table is empty AND no filters are active, the user
  // is more likely missing the tracing wiring than the eval product —
  // surface a setup hint instead.
  const hasActiveFilters = !!(filters.q || filters.from || filters.to)
  const isGenuinelyEmpty = !isLoading && !isError && total === 0 && !hasActiveFilters

  return (
    // Fill the viewport below the dashboard chrome so the table gets its
    // own scroll region instead of pushing pagination off-screen.
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-3">
      {isGenuinelyEmpty ? <WireTracingNote /> : <TraceEvalsUpsellNote />}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <SamplesFilters
            filters={filters}
            searchInput={searchInput}
            onSearchInputChange={setSearchInput}
            onChange={update}
          />
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
          title="Nothing to review yet"
          body="Once your app produces AI output, it'll appear here so you can flag any that need a closer look."
        />
      ) : (
        <SamplesTable
          samples={samples}
          sortBy={filters.sortBy}
          sortDir={filters.sortDir}
          onSort={toggleSort}
          onRowClick={(_t, idx) => setReviewIndex(idx)}
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

      <SampleReviewDialog
        samples={samples}
        index={reviewIndex}
        onIndexChange={setReviewIndex}
        onClose={() => setReviewIndex(-1)}
      />
    </div>
  )
}

function TraceEvalsUpsellNote() {
  return (
    <DeveloperNote>
      Enable <strong>Trace Evals</strong> to catch contradictions in
      feedback and turn feedback into suggested prompt changes.{' '}
      <a
        href="https://gravel.artanis.ai/sign-in?redirect_url=%2Fprojects"
        target="_blank"
        rel="noopener noreferrer"
        className="cursor-pointer underline hover:text-text-dark"
      >
        Create an API key here
      </a>
      .
    </DeveloperNote>
  )
}

function WireTracingNote() {
  return (
    <DeveloperNote>
      No traces yet. Run{' '}
      <CopyableCode>gravel init --traces</CopyableCode>
      {' '}to wire them up then trigger any LLM call from your app.
    </DeveloperNote>
  )
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
  searchInput,
  onSearchInputChange,
  onChange,
}: {
  filters: SampleFilters
  searchInput: string
  onSearchInputChange: (next: string) => void
  onChange: <K extends keyof SampleFilters>(key: K, value: SampleFilters[K]) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Search takes the available width; date range sits to its right. */}
      <div className="relative min-w-0 flex-1">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.5" y2="16.5" />
          </svg>
        </span>
        <input
          type="search"
          value={searchInput}
          onChange={(e) => onSearchInputChange(e.target.value)}
          placeholder="Search prompts, responses, models…"
          aria-label="Search samples"
          className="w-full rounded-lg border border-warm bg-white py-2 pl-9 pr-9 text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => onSearchInputChange('')}
            aria-label="Clear search"
            className="absolute inset-y-0 right-2 flex cursor-pointer items-center px-1 text-text-muted hover:text-text-dark"
          >
            ✕
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 text-xs text-text-mid">
        <input
          type="date"
          value={filters.from}
          onChange={(e) => onChange('from', e.target.value)}
          aria-label="From date"
          className="cursor-pointer rounded-md border border-warm bg-white px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <span className="text-text-muted">→</span>
        <input
          type="date"
          value={filters.to}
          onChange={(e) => onChange('to', e.target.value)}
          aria-label="To date"
          className="cursor-pointer rounded-md border border-warm bg-white px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        {(filters.from || filters.to) && (
          <button
            type="button"
            onClick={() => {
              onChange('from', '')
              onChange('to', '')
            }}
            aria-label="Clear date range"
            title="Clear dates"
            className="cursor-pointer rounded-md p-1 text-text-muted hover:bg-warm hover:text-text-dark"
          >
            ✕
          </button>
        )}
      </div>
    </div>
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
  /** Idx is the position within the current page — used for prev/next in the dialog. */
  onRowClick: (sample: SampleListItem, idx: number) => void
}) {
  return (
    // flex-1 + overflow-auto make the table own the remaining vertical
    // space and scroll internally; the sticky header + pagination
    // outside stay pinned.
    <div className="flex-1 overflow-auto rounded-lg border border-warm bg-cream">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 border-b border-warm bg-warm/80 text-[11px] uppercase tracking-wide text-text-mid backdrop-blur">
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
          {samples.map((s, idx) => (
            <SampleRow key={s.id} sample={s} onClick={() => onRowClick(s, idx)} />
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

