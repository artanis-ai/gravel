/**
 * Alert block for surfacing errors inside a form / modal.
 *
 * Replaces the earlier "one line of red text below the submit button"
 * pattern, which was easy to miss and dropped the server's `message`
 * and `details`. The block now shows:
 *
 *   - a short title (the error code, humanised by the caller)
 *   - the server's `message` field on its own line
 *   - an optional <details> disclosure for raw `details` / `code` so
 *     the developer can read it but the DE doesn't have to
 *
 * `tone="error"` is the only tone today; the type is open so we can
 * add `warning` / `info` without rewriting call sites.
 */
import type { ReactNode } from 'react'

export type AlertTone = 'error'

export function Alert({
  tone = 'error',
  title,
  children,
  details,
  onDismiss,
}: {
  tone?: AlertTone
  /** Short headline — humanised error code or "Couldn't send for review". */
  title: string
  /** Main body. Usually the server's `message`. */
  children: ReactNode
  /** Optional raw upstream detail. Folded behind a disclosure. */
  details?: string | null
  /** When present, renders a close button. */
  onDismiss?: () => void
}) {
  // Tones map to the dashboard's existing palette so the alert reads
  // like part of the chrome (no new colours, no Tailwind plugins).
  const tones: Record<AlertTone, string> = {
    error: 'border-rose-300/60 bg-rose-50 text-rose-900',
  }
  return (
    <div
      role="alert"
      aria-live="polite"
      className={`relative rounded-lg border px-3 py-2 text-xs ${tones[tone]}`}
    >
      <div className="flex items-start gap-2 pr-6">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <div className="mt-1 break-words">{children}</div>
          {details && (
            <details className="mt-2 text-text-muted">
              <summary className="cursor-pointer select-none">Details</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
                {details}
              </pre>
            </details>
          )}
        </div>
      </div>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="absolute right-2 top-1.5 cursor-pointer rounded p-1 leading-none hover:bg-rose-100/60"
        >
          ×
        </button>
      )}
    </div>
  )
}
