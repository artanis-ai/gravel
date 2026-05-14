/**
 * FetchHeader — small strip shown above the conversation when the
 * sample originated from the raw-fetch tracer (trace name starts
 * with `fetch:`). Surfaces the URL, HTTP method, and response
 * status so the reviewer can tell the call bypassed an SDK.
 */
import type { ReactNode } from 'react'

interface FetchHeaderProps {
  url?: string
  method?: string
  status?: number
  statusText?: string
}

export function FetchHeader({ url, method, status, statusText }: FetchHeaderProps): ReactNode {
  if (!url && !method && status === undefined) return null
  const isError = typeof status === 'number' && (status < 200 || status >= 400)
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-warm bg-warm/30 px-2 py-1 text-xs">
      <span className="inline-flex items-center gap-1 rounded bg-warm px-1.5 py-0.5 font-mono text-[10px] uppercase">
        fetch
      </span>
      {method && (
        <span className="font-mono text-[11px] font-medium text-text-dark">{method}</span>
      )}
      {url && (
        <span className="break-all font-mono text-[11px] text-text-muted">{url}</span>
      )}
      {typeof status === 'number' && (
        <span
          className={
            isError
              ? 'ml-auto inline-flex items-center rounded bg-red-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-red-700'
              : 'ml-auto inline-flex items-center rounded bg-forest/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-forest'
          }
        >
          {status}
          {statusText ? ` ${statusText}` : ''}
        </span>
      )}
    </div>
  )
}
