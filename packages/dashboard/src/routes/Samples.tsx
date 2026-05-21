/**
 * Review tab — paginated list of AI samples + a modal reviewer for each.
 * Route is /samples (the SDK still calls them samples internally); the
 * tab label and UX is the domain expert's "Review" surface.
 *
 * Calls `GET /api/samples`, `GET /api/samples/:id`, `POST /api/samples/:id/feedback`.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  type SampleDetailResponse,
  type SampleListItem,
  type SampleStatus,
  type SamplesResponse,
} from '../lib/types'
import { EmptyState } from '../components/EmptyState'
import { DeveloperNote } from '../components/DeveloperNote'
import { CopyableCode } from '../components/CopyableCode'
import { SkeletonTable, SkeletonText } from '../components/Skeleton'
import { Badge } from '../components/Badge'
import { SampleReviewDialog } from '../components/samples/SampleReviewDialog'
import { cx, formatDuration, formatRelative, formatTokens } from '../lib/format'
import { gravelCommand } from '../lib/runtime'

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
  // Deep-link path (`/samples/:id`): open the canonical
  // SampleReviewDialog with this sample as the only item. The
  // previous inline detail body had its own Thumbs-up/down form +
  // raw JSON payload viewer (no ReviewSurface, no PDF rendering, no
  // toast feedback flow) and was effectively a parallel UI; deleted
  // in v0.9.5.
  if (sampleId) return <DeepLinkedSample sampleId={sampleId} />
  return <SamplesList />
}

/** Renders SampleReviewDialog as a full-page modal targeting a
 *  single sample. Used for /samples/:id direct nav so deep links +
 *  browser back work without forking the UX. */
function DeepLinkedSample({ sampleId }: { sampleId: string }) {
  const [, navigate] = useLocation()
  const { data, isLoading, isError, error } = useQuery<SampleDetailResponse>({
    queryKey: ['sample', sampleId],
    queryFn: () => api.get<SampleDetailResponse>(`/api/samples/${sampleId}`),
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
  // `SampleDetailResponse.sample` is a superset of `SampleListItem`;
  // safe to hand to the dialog as a one-element list.
  const samples = [data.sample]
  return (
    <SampleReviewDialog
      samples={samples}
      index={0}
      onIndexChange={() => {
        /* no prev/next on a single-sample deep link */
      }}
      onClose={() => navigate('/samples')}
    />
  )
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
      <CopyableCode>{gravelCommand('traces --apply')}</CopyableCode>
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


