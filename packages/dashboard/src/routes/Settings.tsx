import { useApi } from '../lib/api'

export function SettingsPage() {
  const { data: gh } = useApi.get<{ connected: boolean }>('/api/github/status')
  const { data: billing } = useApi.get<{ tier: string; creditsRemaining: number }>('/api/billing/credits')

  return (
    <div className="space-y-8 max-w-2xl">
      <h1 className="font-display text-2xl font-semibold text-text-dark">Settings</h1>

      <section className="rounded-2xl border border-warm bg-cream p-6">
        <h2 className="font-display font-semibold text-text-dark">GitHub</h2>
        <p className="mt-1 text-sm text-text-mid">
          Connect a GitHub App to enable prompt PRs.
        </p>
        <p className="mt-3 text-sm">
          Status: {gh?.connected ? <span className="text-forest">Connected</span> : <span className="text-text-muted">Not connected</span>}
        </p>
      </section>

      <section className="rounded-2xl border border-warm bg-cream p-6">
        <h2 className="font-display font-semibold text-text-dark">Billing</h2>
        <p className="mt-3 text-sm text-text-mid">Tier: <span className="font-medium text-text-dark">{billing?.tier ?? 'free'}</span></p>
        <p className="mt-1 text-sm text-text-mid">Credits remaining: <span className="font-mono text-text-dark">{billing?.creditsRemaining ?? 0}</span></p>
      </section>
    </div>
  )
}
