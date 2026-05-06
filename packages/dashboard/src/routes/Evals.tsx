/**
 * Evals — runs list + per-run detail.
 *
 * Spec: gravel-cloud/docs/spec/dashboard.md §5 + spec/evals.md.
 * Calls `GET /api/evals/runs`, `GET /api/evals/runs/:id`,
 * `POST /api/evals/runs/:id/cancel`. Streams progress via SSE on
 * `/api/evals/runs/:id/stream` if available, falls back to polling.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  type EvalResultRow,
  type EvalRunDetailResponse,
  type EvalRunStatus,
  type EvalRunSummary,
  type EvalRunsResponse,
} from '../lib/types'
import { EmptyState } from '../components/EmptyState'
import { SkeletonTable, SkeletonText } from '../components/Skeleton'
import { Badge } from '../components/Badge'
import { Modal } from '../components/Modal'
import { asString, cx, formatRelative, truncate } from '../lib/format'

export function EvalsPage({ runId }: { runId?: string } = {}) {
  if (runId) return <EvalRunDetail runId={runId} />
  return <EvalRunsList />
}

// ---------- List ----------

function EvalRunsList() {
  const { data, isLoading, isError, error } = useQuery<EvalRunsResponse>({
    queryKey: ['eval-runs'],
    queryFn: () => api.get<EvalRunsResponse>('/api/evals/runs'),
    refetchInterval: 5000,
  })

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold text-text-dark">Eval runs</h1>
        <p className="mt-1 text-sm text-text-mid">All trace + live eval runs across datasets, most recent first.</p>
      </header>

      {isError ? (
        <p className="rounded-2xl border border-primary/30 bg-primary/5 p-4 font-mono text-xs text-primary-dark">
          {(error as Error)?.message ?? 'Failed to load runs.'}
        </p>
      ) : isLoading ? (
        <div className="rounded-2xl border border-warm bg-cream p-4">
          <SkeletonTable rows={5} cols={5} />
        </div>
      ) : !data || data.runs.length === 0 ? (
        <EmptyState
          title="No eval runs yet"
          body="Once you have a dataset of labelled traces, click 'Run trace eval' to score them."
        />
      ) : (
        <RunsTable runs={data.runs} />
      )}
    </div>
  )
}

function RunsTable({ runs }: { runs: EvalRunSummary[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-warm bg-cream">
      <table className="w-full text-sm">
        <thead className="bg-warm/40 text-xs uppercase tracking-wide text-text-mid">
          <tr>
            <th className="px-4 py-2 text-left font-medium">When</th>
            <th className="px-4 py-2 text-left font-medium">Dataset</th>
            <th className="px-4 py-2 text-left font-medium">Type</th>
            <th className="px-4 py-2 text-right font-medium">Progress</th>
            <th className="px-4 py-2 text-left font-medium">Status</th>
            <th className="px-4 py-2 text-left font-medium">Summary</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-warm hover:bg-warm/30">
              <td className="px-4 py-2 text-xs text-text-mid">
                <Link
                  href={`/evals/${r.id}`}
                  className="cursor-pointer text-text-dark hover:underline"
                  data-testid={`run-link-${r.id}`}
                >
                  {formatRelative(r.created_at)}
                </Link>
              </td>
              <td className="px-4 py-2 text-text-dark">{r.dataset_name}</td>
              <td className="px-4 py-2 text-xs uppercase text-text-mid">{r.type}</td>
              <td className="px-4 py-2 text-right font-mono text-xs text-text-mid">
                {r.completed_rows}/{r.total_rows || '?'}
              </td>
              <td className="px-4 py-2"><RunStatusBadge status={r.status} /></td>
              <td className="px-4 py-2 text-xs text-text-mid">{summaryText(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function summaryText(run: EvalRunSummary): string {
  if (!run.summary) return '—'
  return `${run.summary.passed} pass · ${run.summary.failed} fail`
}

function RunStatusBadge({ status }: { status: EvalRunStatus }) {
  const map: Record<EvalRunStatus, { tone: 'good' | 'bad' | 'neutral' | 'warn' | 'info'; icon: string; label: string }> = {
    queued: { tone: 'neutral', icon: '·', label: 'queued' },
    pending: { tone: 'neutral', icon: '·', label: 'pending' },
    running: { tone: 'info', icon: '●', label: 'running' },
    completed: { tone: 'good', icon: '✓', label: 'done' },
    cancelled: { tone: 'warn', icon: '⊘', label: 'cancelled' },
    errored: { tone: 'bad', icon: '✕', label: 'failed' },
  }
  const m = map[status]
  return <Badge tone={m.tone} icon={m.icon}>{m.label}</Badge>
}

// ---------- Detail ----------

function EvalRunDetail({ runId }: { runId: string }) {
  const queryClient = useQueryClient()
  const path = `/api/evals/runs/${runId}`

  const { data, isLoading, isError, error, refetch } = useQuery<EvalRunDetailResponse>({
    queryKey: ['eval-run', runId],
    queryFn: () => api.get<EvalRunDetailResponse>(path),
  })

  const status = data?.run.status
  const isLive = status === 'running' || status === 'pending' || status === 'queued'

  // Stream progress via SSE; if 404 → fall back to 2s poll.
  useStreamOrPoll(runId, isLive, () => {
    queryClient.invalidateQueries({ queryKey: ['eval-run', runId] })
  })

  const [breakdownRow, setBreakdownRow] = useState<EvalResultRow | null>(null)

  const cancel = useMutation<unknown, Error, void>({
    mutationFn: () => api.post(`/api/evals/runs/${runId}/cancel`),
    onSuccess: () => refetch(),
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <SkeletonText lines={2} />
        <div className="rounded-2xl border border-warm bg-cream p-4">
          <SkeletonTable rows={6} cols={5} />
        </div>
      </div>
    )
  }
  if (isError || !data) {
    return (
      <p className="rounded-2xl border border-primary/30 bg-primary/5 p-4 font-mono text-xs text-primary-dark">
        {(error as Error)?.message ?? 'Failed to load run.'}
      </p>
    )
  }

  const { run, results } = data
  const progress = run.total_rows > 0 ? Math.round((run.completed_rows / run.total_rows) * 100) : 0

  return (
    <div className="space-y-6">
      <div>
        <Link href="/evals" className="cursor-pointer text-xs text-text-mid hover:text-text-dark">
          ← All runs
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-4">
          <h1 className="font-display text-2xl font-semibold text-text-dark">
            {run.dataset_name}{' '}
            <span className="font-mono text-sm font-normal text-text-muted">{run.type} eval</span>
          </h1>
          {isLive && (
            <button
              type="button"
              disabled={cancel.isPending}
              className={cx(
                'rounded-lg border px-3 py-1.5 text-sm',
                cancel.isPending
                  ? 'cursor-not-allowed border-warm text-text-muted'
                  : 'cursor-pointer border-primary text-primary hover:bg-primary/10',
              )}
              onClick={() => cancel.mutate()}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel run'}
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-text-mid">
          <RunStatusBadge status={run.status} />
          <span>
            {run.completed_rows}/{run.total_rows} rows
          </span>
          {run.summary && (
            <span>
              <span className="text-forest">{run.summary.passed} pass</span> ·{' '}
              <span className="text-primary-dark">{run.summary.failed} fail</span>
            </span>
          )}
          {run.started_at && <span>started {formatRelative(run.started_at)}</span>}
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-warm">
          <div
            className={cx(
              'h-full',
              run.status === 'errored' ? 'bg-primary' : run.status === 'cancelled' ? 'bg-accent' : 'bg-forest',
            )}
            style={{ width: `${progress}%` }}
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>

      {results.length === 0 ? (
        <p className="text-sm text-text-mid">
          {isLive ? 'No rows scored yet — judge calls start in a moment.' : 'No rows in this run.'}
        </p>
      ) : (
        <ResultsTable results={results} onBreakdown={setBreakdownRow} />
      )}

      <BreakdownModal row={breakdownRow} onClose={() => setBreakdownRow(null)} />
    </div>
  )
}

function ResultsTable({
  results,
  onBreakdown,
}: {
  results: EvalResultRow[]
  onBreakdown: (row: EvalResultRow) => void
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-warm bg-cream">
      <table className="w-full text-sm">
        <thead className="bg-warm/40 text-xs uppercase tracking-wide text-text-mid">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Input</th>
            <th className="px-4 py-2 text-left font-medium">Expected</th>
            <th className="px-4 py-2 text-left font-medium">Output</th>
            <th className="px-4 py-2 text-right font-medium">Score</th>
            <th className="px-4 py-2 text-left font-medium">Verdict</th>
            <th className="px-4 py-2 text-left font-medium">Breakdown</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.id} className="border-t border-warm">
              <td className="px-4 py-2 align-top text-xs text-text-dark">{truncate(r.input_snippet ?? '', 60)}</td>
              <td className="px-4 py-2 align-top text-xs text-text-mid">{truncate(r.expected ?? '', 60)}</td>
              <td className="px-4 py-2 align-top text-xs text-text-mid">
                {asString(r.live_output ?? r.output, 60)}
              </td>
              <td className="px-4 py-2 align-top text-right font-mono text-xs text-text-dark">
                {(r.verdict.score ?? 0).toFixed(2)}
              </td>
              <td className="px-4 py-2 align-top">
                {r.verdict.passed ? <Badge tone="good" icon="✓">pass</Badge> : <Badge tone="bad" icon="✕">fail</Badge>}
              </td>
              <td className="px-4 py-2 align-top">
                <button
                  type="button"
                  className="cursor-pointer text-xs text-primary hover:underline"
                  onClick={() => onBreakdown(r)}
                  aria-label={`Show breakdown for row ${r.id}`}
                >
                  details →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BreakdownModal({ row, onClose }: { row: EvalResultRow | null; onClose: () => void }) {
  const open = row !== null
  const breakdown = row?.verdict.breakdown ?? {}
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Verdict breakdown"
      footer={
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-warm px-3 py-1.5 text-sm hover:bg-warm"
          onClick={onClose}
        >
          Close
        </button>
      }
    >
      {row && (
        <div className="space-y-3 text-sm">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-mid">Reasoning</h3>
            <p className="mt-1 whitespace-pre-wrap text-text-dark">{row.verdict.reasoning}</p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-mid">Per-criterion</h3>
            <ul className="mt-1 space-y-1">
              {Object.entries(breakdown).map(([k, v]) => (
                <li key={k} className="flex items-center gap-3">
                  <span className="w-24 text-xs text-text-mid">{k}</span>
                  <div className="h-2 flex-1 rounded-full bg-warm">
                    <div
                      className="h-full rounded-full bg-forest"
                      style={{ width: `${Math.round((v ?? 0) * 100)}%` }}
                    />
                  </div>
                  <span className="w-10 text-right font-mono text-xs text-text-dark">{(v ?? 0).toFixed(2)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  )
}

/**
 * Subscribe to SSE on /api/evals/runs/:id/stream while the run is live.
 * On 404 (handler not yet implemented), poll the detail endpoint every 2s.
 */
function useStreamOrPoll(runId: string, active: boolean, onTick: () => void) {
  // Keep latest onTick callable without re-binding the effect every render.
  const tickRef = useMemoCallback(onTick)

  useEffect(() => {
    if (!active) return
    const mount = (window as unknown as { __GRAVEL_MOUNT_PATH__?: string }).__GRAVEL_MOUNT_PATH__ ?? ''
    const url = `${mount}/api/evals/runs/${runId}/stream`
    let es: EventSource | null = null
    let pollHandle: number | null = null
    let cancelled = false

    function startPolling() {
      pollHandle = window.setInterval(() => tickRef.current(), 2000)
    }

    function stopPolling() {
      if (pollHandle != null) {
        window.clearInterval(pollHandle)
        pollHandle = null
      }
    }

    // Try SSE first. EventSource doesn't expose status codes directly, but a
    // 404 surfaces as an `error` event before any messages — at which point
    // we tear it down and fall back to polling.
    try {
      es = new EventSource(url, { withCredentials: true })
      let gotMessage = false
      es.onmessage = () => {
        gotMessage = true
        tickRef.current()
      }
      es.onerror = () => {
        if (cancelled) return
        if (!gotMessage) {
          es?.close()
          es = null
          startPolling()
        }
      }
    } catch {
      startPolling()
    }

    return () => {
      cancelled = true
      es?.close()
      stopPolling()
    }
  }, [runId, active, tickRef])
}

function useMemoCallback<T extends (...args: never[]) => unknown>(fn: T) {
  const ref = useMemo(() => ({ current: fn }), []) as { current: T }
  ref.current = fn
  return ref
}
