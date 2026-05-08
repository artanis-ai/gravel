/**
 * Review — the workspace where a domain expert goes through outputs
 * they (or someone on their team) flagged from the Outputs tab. Issues
 * (regressions surfaced by evals) also land here.
 *
 * Folds in what was previously two separate tabs (Datasets + Evals).
 * From the DE's perspective they're the same workflow: "look at AI
 * output that needs my attention, mark it good/bad, move on."
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { EmptyState } from '../components/EmptyState'
import { SkeletonTable } from '../components/Skeleton'
import { DeveloperNote } from '../components/DeveloperNote'
import type { DatasetsResponse, EvalRunsResponse } from '../lib/types'

export function ReviewPage() {
  const flaggedQ = useQuery<DatasetsResponse>({
    queryKey: ['review', 'flagged'],
    queryFn: () => api.get<DatasetsResponse>('/api/datasets'),
  })
  const runsQ = useQuery<EvalRunsResponse>({
    queryKey: ['review', 'runs'],
    queryFn: () => api.get<EvalRunsResponse>('/api/evals/runs'),
  })

  const isLoading = flaggedQ.isLoading || runsQ.isLoading
  const flagged = flaggedQ.data?.datasets ?? []
  const runs = runsQ.data?.runs ?? []
  const hasIssues = runs.some(
    (r) => r.status === 'errored' || (r.summary?.failed ?? 0) > 0,
  )

  return (
    <div className="space-y-6">
      {hasIssues && (
        <section className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-sm text-primary-dark">
          <h2 className="font-display font-semibold">Issues</h2>
          <ul className="mt-2 space-y-1">
            {runs
              .filter((r) => r.status === 'errored' || (r.summary?.failed ?? 0) > 0)
              .map((r) => (
                <li key={r.id} className="font-mono text-xs">
                  {r.dataset_name} — {r.status}
                  {r.summary && ` (${r.summary.failed}/${r.total_rows} failed)`}
                </li>
              ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-display font-semibold text-text-dark">Flagged outputs</h2>
        {isLoading ? (
          <div className="rounded-2xl border border-warm bg-cream p-4">
            <SkeletonTable rows={4} cols={4} />
          </div>
        ) : flagged.length === 0 ? (
          <div className="space-y-3">
            <EmptyState
              title="Nothing flagged yet"
              body="When you flag outputs from the Outputs tab, they'll land here so you can review them in batches."
            />
            <DeveloperNote>
              Flagged outputs accumulate into datasets your team can run evals against. Issues
              (regressions vs. the last accepted run) surface at the top of this page.
            </DeveloperNote>
          </div>
        ) : (
          <ul className="divide-y divide-warm rounded-2xl border border-warm bg-cream">
            {flagged.map((d) => (
              <li key={d.id} className="px-4 py-3 text-sm">
                <div className="font-medium text-text-dark">{d.name}</div>
                <div className="text-xs text-text-mid">
                  {d.trace_count} item{d.trace_count === 1 ? '' : 's'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
