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

/**
 * Structured error from any SDK route. SDK error responses look like
 * `{ error: <code>, message?: <human>, details?: <raw> }` — we preserve
 * all three on the thrown Error so call sites can render a proper
 * alert (code as title, message as body, details as collapsed
 * disclosure) instead of dropping everything but `error` like before.
 */
export class ApiError extends Error {
  status: number
  code: string
  /** Human-readable message from the server, if any. */
  serverMessage: string | null
  /** Raw upstream detail (e.g. a GitHub error string). */
  details: unknown

  constructor(opts: {
    status: number
    code: string
    serverMessage: string | null
    details: unknown
  }) {
    // .message is what useMutation surfaces by default; pick the most
    // useful summary we have so the legacy "just show err.message"
    // pattern still produces something readable.
    const summary =
      opts.serverMessage ||
      opts.code ||
      `${opts.status} ${opts.code || 'error'}`
    super(summary)
    this.name = 'ApiError'
    this.status = opts.status
    this.code = opts.code
    this.serverMessage = opts.serverMessage
    this.details = opts.details
  }
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
    let code = ''
    let serverMessage: string | null = null
    let details: unknown = null
    try {
      const body = await response.clone().json()
      if (body && typeof body.error === 'string') code = body.error
      if (body && typeof body.message === 'string') serverMessage = body.message
      if (body && 'details' in body) details = body.details
    } catch {
      /* not JSON — leave fields blank, ApiError surfaces a status line */
    }
    throw new ApiError({
      status: response.status,
      code: code || `${response.status}`,
      serverMessage,
      details,
    })
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
