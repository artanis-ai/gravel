import type { ReactNode } from 'react'

export function EmptyState({ title, body, action }: { title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-warm bg-warm/40 p-10 text-center">
      <h3 className="font-display text-lg font-semibold text-text-dark">{title}</h3>
      <div className="mt-2 text-sm text-text-mid">{body}</div>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
