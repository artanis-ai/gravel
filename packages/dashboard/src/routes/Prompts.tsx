import { useApi } from '../lib/api'
import { EmptyState } from '../components/EmptyState'

export function PromptsPage(_: { promptId?: string } = {}) {
  const { data, isLoading } = useApi.get<{ prompts: any[] }>('/api/prompts')
  if (isLoading) return <p className="text-text-mid text-sm">Loading…</p>

  if (!data?.prompts?.length) {
    return (
      <EmptyState
        title="No prompts yet"
        body={
          <>
            We didn't find any prompts in your repo. Try{' '}
            <code className="bg-cream px-1 py-0.5 rounded font-mono text-xs">npx @artanis-ai/gravel scan --deep</code>{' '}
            to look for embedded prompts, or check that your manifest is up to date.
          </>
        }
      />
    )
  }

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-text-dark mb-2">Prompts</h1>
      {/* BLOCKER: full prompt list + editor lands alongside the lib's PUT /api/prompts/:id wiring. */}
      <p className="text-sm text-text-mid">
        {data.prompts.length} prompts. Full list + inline editor lands in the next session.
      </p>
    </div>
  )
}
