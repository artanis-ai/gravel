/**
 * ErrorBanner — red-tinted panel surfaced above the renderer when
 * the sample errored. Pulls error info from `metadata.error`
 * (gravel-SDK convention: `{message, type, status?, request_id?,
 * stack?}`) so renderers can stay pure mechanical and not
 * special-case the errored path.
 */
import type { ReactNode } from 'react'

import { HumanValue } from './HumanValue'

interface ErrorBannerProps {
  error: unknown
}

export function ErrorBanner({ error }: ErrorBannerProps): ReactNode {
  if (!isPlainObject(error)) return null
  const message = typeof error.message === 'string' ? error.message : null
  const type = typeof error.type === 'string' ? error.type : null
  const status = typeof error.status === 'number' ? error.status : null
  const requestId = typeof error.request_id === 'string' ? error.request_id : null
  const stack = typeof error.stack === 'string' ? error.stack : null

  return (
    <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-red-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-800">
          Errored
        </span>
        {type && (
          <span className="font-mono text-[11px] text-red-700">{type}</span>
        )}
        {status !== null && (
          <span className="font-mono text-[11px] text-red-700">{status}</span>
        )}
        {requestId && (
          <span className="ml-auto font-mono text-[10px] text-red-600">{requestId}</span>
        )}
      </div>
      {message && (
        <p className="whitespace-pre-wrap text-sm text-red-900">{message}</p>
      )}
      {stack && <StackDisclosure stack={stack} />}
      {!message && !type && !status && (
        <div className="text-sm text-red-900">
          <HumanValue value={error} />
        </div>
      )}
    </div>
  )
}

function StackDisclosure({ stack }: { stack: string }): ReactNode {
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer text-red-700">Stack trace</summary>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-red-900">
        {stack}
      </pre>
    </details>
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
