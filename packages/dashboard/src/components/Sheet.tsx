/**
 * Right-side slide-in sheet — used for trace detail in the Outputs
 * tab so the DE can scrub through traces without losing context.
 *
 * Unlike Modal, the sheet is anchored to the right edge and scrolls
 * its own body so the table behind stays visible (mostly grayed by
 * the backdrop). Closes on Escape or backdrop click.
 *
 * No portal — same reasoning as Modal: the dashboard mounts inside
 * the user's app and we don't want to escape the scoped CSS.
 */
import { useEffect, type ReactNode } from 'react'

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="flex-1 cursor-pointer bg-text-dark/30"
        onClick={onClose}
      />
      <aside className="flex h-full w-full max-w-3xl flex-col bg-cream shadow-2xl ring-1 ring-warm">
        <header className="flex items-start justify-between gap-3 border-b border-warm px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="font-display text-lg font-semibold text-text-dark">{title}</div>
            {subtitle ? <div className="mt-0.5 text-xs text-text-mid">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-text-muted hover:bg-warm hover:text-text-dark"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="border-t border-warm bg-warm/30 px-5 py-3">{footer}</div> : null}
      </aside>
    </div>
  )
}
