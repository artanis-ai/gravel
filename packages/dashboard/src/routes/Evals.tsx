import { EmptyState } from '../components/EmptyState'

export function EvalsPage(_: { runId?: string } = {}) {
  return (
    <EmptyState
      title="Evals ship in v2 (paid)"
      body="Run trace evals (replay stored outputs through Gravel's judge) and live evals (call your pipeline) from this view."
    />
  )
}
