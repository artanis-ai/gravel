/**
 * Centred modal dialog. Used by the Review tab to inspect a single
 * sample without losing the table context behind it.
 *
 * Differs from `Sheet`:
 *   - Centred + capped at ~80vw / 90vh instead of pinned to the right.
 *   - Caller controls the layout inside the body — no built-in title
 *     header (the dialog often wants its own toolbar with prev/next +
 *     close colocated, not a passive title row).
 *   - Backdrop click + Escape both close (Sheet has the same).
 */
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface DialogProps {
  open: boolean
  onClose: () => void
  /** ARIA label for the dialog itself; required for screen readers. */
  ariaLabel: string
  children: ReactNode
  /** Override the default max-width (`max-w-6xl`). */
  maxWidthClass?: string
}

export function Dialog({ open, onClose, ariaLabel, children, maxWidthClass = 'max-w-6xl' }: DialogProps) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Lock body scroll while modal is up.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      role="presentation"
    >
      {/* Backdrop: click-to-close. Pointer-events on the backdrop only;
          children stop propagation so a click inside the dialog doesn't
          dismiss it. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-text-dark/40 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`relative flex max-h-[90vh] w-full ${maxWidthClass} flex-col overflow-hidden rounded-2xl bg-cream shadow-2xl ring-1 ring-warm`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
  return createPortal(modal, document.body)
}
