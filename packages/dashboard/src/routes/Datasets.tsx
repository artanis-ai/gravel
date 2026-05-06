/**
 * Datasets — list + detail.
 *
 * Spec: gravel-cloud/docs/spec/dashboard.md §5 (`/datasets`, `/datasets/:id`).
 * Calls `GET /api/datasets`, `POST /api/datasets`, `POST /api/datasets/:id/traces`,
 * `POST /api/evals/runs`.
 */
import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'wouter'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  type DatasetDetailResponse,
  type DatasetsResponse,
  type DatasetSummary,
  type EvalRunSummary,
  type EvalRunType,
} from '../lib/types'
import { EmptyState } from '../components/EmptyState'
import { SkeletonTable, SkeletonText } from '../components/Skeleton'
import { Badge } from '../components/Badge'
import { Modal } from '../components/Modal'
import { cx, formatDuration, formatRelative, formatTokens } from '../lib/format'

export function DatasetsPage({ datasetId }: { datasetId?: string } = {}) {
  if (datasetId) return <DatasetDetail datasetId={datasetId} />
  return <DatasetsList />
}

// ---------- List ----------

function DatasetsList() {
  const queryClient = useQueryClient()
  const { data, isLoading, isError, error } = useQuery<DatasetsResponse>({
    queryKey: ['datasets'],
    queryFn: () => api.get<DatasetsResponse>('/api/datasets'),
  })
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text-dark">Datasets</h1>
          <p className="mt-1 text-sm text-text-mid">
            Group labelled traces for trace + live evals.
          </p>
        </div>
        <button
          type="button"
          className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
          onClick={() => setCreateOpen(true)}
        >
          New dataset
        </button>
      </header>

      {isError ? (
        <p className="rounded-2xl border border-primary/30 bg-primary/5 p-4 font-mono text-xs text-primary-dark">
          {(error as Error)?.message ?? 'Failed to load datasets.'}
        </p>
      ) : isLoading ? (
        <div className="rounded-2xl border border-warm bg-cream p-4">
          <SkeletonTable rows={4} cols={3} />
        </div>
      ) : !data || data.datasets.length === 0 ? (
        <EmptyState
          title="No datasets yet"
          body="Datasets group traces for evals. Browse the trace inbox, label some, and click 'Add to dataset' to get started."
          action={
            <button
              type="button"
              className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
              onClick={() => setCreateOpen(true)}
            >
              New dataset
            </button>
          }
        />
      ) : (
        <DatasetTable datasets={data.datasets} />
      )}

      <NewDatasetModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['datasets'] })}
      />
    </div>
  )
}

function DatasetTable({ datasets }: { datasets: DatasetSummary[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-warm bg-cream">
      <table className="w-full text-sm">
        <thead className="bg-warm/40 text-xs uppercase tracking-wide text-text-mid">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Name</th>
            <th className="px-4 py-2 text-right font-medium">Traces</th>
            <th className="px-4 py-2 text-left font-medium">Last modified</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((d) => (
            <tr key={d.id} className="border-t border-warm hover:bg-warm/30">
              <td className="px-4 py-2">
                <Link
                  href={`/datasets/${d.id}`}
                  className="cursor-pointer text-text-dark hover:underline"
                  data-testid={`dataset-link-${d.id}`}
                >
                  {d.name}
                </Link>
                {d.description && <div className="text-xs text-text-muted">{d.description}</div>}
              </td>
              <td className="px-4 py-2 text-right font-mono text-xs text-text-mid">{d.trace_count}</td>
              <td className="px-4 py-2 text-xs text-text-mid">{formatRelative(d.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function NewDatasetModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation<DatasetSummary, Error, void>({
    mutationFn: () => api.post<DatasetSummary>('/api/datasets', { name, description: description || null }),
    onSuccess: () => {
      setName('')
      setDescription('')
      setError(null)
      onCreated()
      onClose()
    },
    onError: (err) => setError(err.message),
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    create.mutate()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New dataset"
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
            type="submit"
            form="new-dataset-form"
            disabled={create.isPending}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium text-white',
              create.isPending ? 'cursor-not-allowed bg-primary/60' : 'cursor-pointer bg-primary hover:bg-primary-dark',
            )}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <form id="new-dataset-form" onSubmit={onSubmit} className="space-y-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-text-mid">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="golden_v2"
            autoFocus
            className="w-full rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-mid">
          Description (optional)
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this dataset covers."
            className="w-full rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            rows={2}
          />
        </label>
        {error && <p className="text-xs text-primary-dark">{error}</p>}
      </form>
    </Modal>
  )
}

// ---------- Detail ----------

function DatasetDetail({ datasetId }: { datasetId: string }) {
  const [, navigate] = useLocation()
  const path = `/api/datasets/${datasetId}`
  const { data, isLoading, isError, error } = useQuery<DatasetDetailResponse>({
    queryKey: ['dataset', datasetId],
    queryFn: () => api.get<DatasetDetailResponse>(path),
  })
  const [runError, setRunError] = useState<string | null>(null)

  const startRun = useMutation<EvalRunSummary, Error, EvalRunType>({
    mutationFn: (type) =>
      api.post<EvalRunSummary>('/api/evals/runs', { datasetId, type }),
    onSuccess: (run) => {
      setRunError(null)
      navigate(`/evals/${run.id}`)
    },
    onError: (err) => setRunError(err.message),
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <SkeletonText lines={2} />
        <div className="rounded-2xl border border-warm bg-cream p-4">
          <SkeletonTable rows={4} cols={4} />
        </div>
      </div>
    )
  }
  if (isError || !data) {
    return (
      <p className="rounded-2xl border border-primary/30 bg-primary/5 p-4 font-mono text-xs text-primary-dark">
        {(error as Error)?.message ?? 'Failed to load dataset.'}
      </p>
    )
  }

  const { dataset, traces, runPipelineConfigured } = data

  return (
    <div className="space-y-6">
      <div>
        <Link href="/datasets" className="cursor-pointer text-xs text-text-mid hover:text-text-dark">
          ← All datasets
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold text-text-dark">{dataset.name}</h1>
        {dataset.description && <p className="mt-1 text-sm text-text-mid">{dataset.description}</p>}
        <p className="mt-1 text-xs text-text-muted">
          {dataset.trace_count} traces · updated {formatRelative(dataset.updated_at)}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={startRun.isPending || dataset.trace_count === 0}
          className={cx(
            'rounded-lg px-3 py-1.5 text-sm font-medium text-white',
            startRun.isPending || dataset.trace_count === 0
              ? 'cursor-not-allowed bg-primary/60'
              : 'cursor-pointer bg-primary hover:bg-primary-dark',
          )}
          onClick={() => startRun.mutate('trace')}
        >
          Run trace eval
        </button>
        <LiveEvalButton
          configured={runPipelineConfigured}
          disabled={startRun.isPending || dataset.trace_count === 0}
          pending={startRun.isPending}
          onClick={() => startRun.mutate('live')}
        />
        {runError && <span className="text-xs text-primary-dark">{runError}</span>}
      </div>

      {traces.length === 0 ? (
        <EmptyState
          title="No traces in this dataset yet"
          body="Browse the trace inbox, label one with feedback, and use 'Add to dataset' to populate this set."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-warm bg-cream">
          <table className="w-full text-sm">
            <thead className="bg-warm/40 text-xs uppercase tracking-wide text-text-mid">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Trace</th>
                <th className="px-4 py-2 text-left font-medium">Model</th>
                <th className="px-4 py-2 text-right font-medium">Tokens</th>
                <th className="px-4 py-2 text-right font-medium">Duration</th>
                <th className="px-4 py-2 text-left font-medium">Feedback</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((row) => (
                <tr key={row.dataset_trace_id} className="border-t border-warm hover:bg-warm/30">
                  <td className="px-4 py-2">
                    <Link
                      href={`/traces/${row.trace.id}`}
                      className="cursor-pointer font-mono text-xs text-text-dark hover:underline"
                    >
                      {row.trace.name}
                    </Link>
                    <div className="text-[11px] text-text-muted">{formatRelative(row.trace.started_at)}</div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-text-mid">{row.trace.model ?? '—'}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-text-mid">
                    {formatTokens(row.trace.tokens_in)} / {formatTokens(row.trace.tokens_out)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-text-mid">
                    {formatDuration(row.trace.duration_ms)}
                  </td>
                  <td className="px-4 py-2">
                    {row.trace.feedback_count > 0 ? (
                      <Badge tone={row.trace.feedback_score === 'negative' ? 'bad' : 'good'}>
                        {row.trace.feedback_count}
                      </Badge>
                    ) : (
                      <span className="text-xs text-text-muted">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function LiveEvalButton({
  configured,
  disabled,
  pending,
  onClick,
}: {
  configured: boolean
  disabled: boolean
  pending: boolean
  onClick: () => void
}) {
  const blocked = !configured || disabled
  const tooltip = !configured
    ? 'Live evals require wiring up `runPipeline` in gravel.config.ts.'
    : disabled
      ? 'Add traces with feedback first.'
      : ''
  return (
    <button
      type="button"
      disabled={blocked}
      title={tooltip || undefined}
      aria-disabled={blocked}
      className={cx(
        'rounded-lg border px-3 py-1.5 text-sm font-medium',
        blocked
          ? 'cursor-not-allowed border-warm bg-warm/40 text-text-muted'
          : 'cursor-pointer border-primary text-primary hover:bg-primary/10',
      )}
      onClick={() => !blocked && onClick()}
    >
      {pending ? 'Starting…' : 'Run live eval'}
    </button>
  )
}
