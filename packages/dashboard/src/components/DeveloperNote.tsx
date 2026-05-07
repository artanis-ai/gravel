/**
 * Renders content only when the viewer is the developer running on
 * localhost. Wraps it in a visibly distinct frame with a "Developer
 * only" tag so the dev never has to wonder whether a domain expert
 * would see the same message — they won't.
 *
 * Why localhost specifically (not just `role: admin`):
 *   - In production, an admin could be the operator/CTO who isn't the
 *     person who ran `pnpm install`. Telling them to run a CLI command
 *     on their dev machine is wrong.
 *   - The localhost shortcut (auth/origin.ts) tags that user as
 *     `id: 'localhost'`, which is the unambiguous signal "you ARE the
 *     developer running this app right now".
 */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

interface MeResponse {
  user?: { id: string }
}

export function DeveloperNote({ children }: { children: ReactNode }) {
  // Same query key as App.tsx so we hit the cache, not the network.
  const { data } = useQuery<MeResponse>({
    queryKey: ['/api/auth/me'],
    queryFn: () => api.get<MeResponse>('/api/auth/me'),
  })
  if (data?.user?.id !== 'localhost') return null

  return (
    <div className="rounded-xl border border-dashed border-text-muted/50 bg-warm/40 p-3 text-xs text-text-mid">
      <div className="mb-1.5 inline-flex items-center gap-1 rounded bg-text-mid/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-mid">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
        Developer only · localhost
      </div>
      <div>{children}</div>
    </div>
  )
}
