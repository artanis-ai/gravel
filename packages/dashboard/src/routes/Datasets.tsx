import { EmptyState } from '../components/EmptyState'

export function DatasetsPage(_: { datasetId?: string } = {}) {
  return (
    <EmptyState
      title="Datasets ship in v1"
      body="Once you have feedback-rich traces, group them into datasets here for evals."
    />
  )
}
