/**
 * Same-origin API client. All calls go to the user's app at the dashboard's
 * mount path (e.g. /admin/ai/api/*). Never to gravel.artanis.ai.
 *
 */
import { useQuery, useMutation, type UseQueryOptions } from '@tanstack/react-query'

function getMountPath(): string {
  // The dashboard is served at MOUNT_PATH/. Strip the trailing slash.
  const path = window.location.pathname.replace(/\/$/, '')
  // Walk back from current URL until we find the mount root.
  // Heuristic: assume mount path is /admin/ai or whatever the lib serves at.
  // For SPA routes (e.g. /prompts/:id), strip until we hit a known prefix.
  // For now, expose via a global the lib injects (BLOCKER: lib does not yet
  // inject this). Default to '' (root-relative).
  void path
  return (window as any).__GRAVEL_MOUNT_PATH__ ?? ''
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(getMountPath() + url, {
    ...init,
    headers: {
      'X-Gravel-CSRF': 'pending', // BLOCKER: CSRF token mechanism wires up alongside auth
      ...(init?.headers ?? {}),
    },
    credentials: 'include',
  })
  if (!response.ok) {
    // Surface the server's `{ error: ... }` body if it sent one — most
    // SDK routes do, and the message is usually actionable
    // (e.g. "GRAVEL_PROJECT_ID not set" tells the dev exactly what's
    // missing). Falls back to the status line otherwise.
    let detail = ''
    try {
      const body = await response.clone().json()
      if (body && typeof body.error === 'string') detail = body.error
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `${response.status} ${response.statusText}`)
  }
  return response.json()
}

export const api = {
  get<T = unknown>(path: string): Promise<T> {
    return fetchJson(path) as Promise<T>
  },
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return fetchJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }) as Promise<T>
  },
  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return fetchJson(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }) as Promise<T>
  },
  delete<T = unknown>(path: string): Promise<T> {
    return fetchJson(path, { method: 'DELETE' }) as Promise<T>
  },
}

export const useApi = {
  get<T = any>(path: string, options?: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>) {
    return useQuery<T>({
      queryKey: [path],
      queryFn: () => api.get<T>(path),
      ...options,
    })
  },
  mutation<T = any, V = any>(method: 'post' | 'put' | 'delete', path: string) {
    return useMutation<T, Error, V>({
      mutationFn: async (body) => {
        if (method === 'delete') return api.delete<T>(path)
        return api[method]<T>(path, body)
      },
    })
  },
}
