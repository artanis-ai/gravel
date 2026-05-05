import { EmptyState } from '../components/EmptyState'

export function TracesPage(_: { traceId?: string } = {}) {
  // BLOCKER: implements alongside v1 tracing patches.
  return (
    <EmptyState
      title="Traces ship in v1"
      body="Auto-patched OpenAI / Anthropic / Langchain / Vercel AI SDK calls will land here. Not yet implemented."
    />
  )
}
