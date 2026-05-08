/**
 * Read `/api/auth/me` once and surface the user. Used to scope per-user
 * localStorage keys (drafts) and to seed the submit form.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

interface MeResponse {
  user: { id: string; firstName: string; role: string }
  productName?: string
  mountPath?: string
  hideArtanisBranding?: boolean
}

export function useCurrentUser(): MeResponse['user'] | null {
  const q = useQuery<MeResponse>({
    queryKey: ['/api/auth/me'],
    queryFn: () => api.get<MeResponse>('/api/auth/me'),
    staleTime: Infinity,
  })
  return q.data?.user ?? null
}
