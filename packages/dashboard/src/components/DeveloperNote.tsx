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
    <div className="overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/80 shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-100 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        Only you can see this box (localhost)
      </div>
      <div className="px-3 py-3 text-xs text-slate-700">{children}</div>
    </div>
  )
}
