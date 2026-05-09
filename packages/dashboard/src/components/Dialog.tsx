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
  /** Default near-full-screen ("fullscreen"); pass "centred" for the
   *  smaller capped variant when a tighter modal makes sense. */
  size?: 'fullscreen' | 'centred'
}

export function Dialog({ open, onClose, ariaLabel, children, size = 'fullscreen' }: DialogProps) {
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

  const sizing =
    size === 'centred'
      ? 'max-h-[90vh] max-w-6xl rounded-2xl'
      : // Fullscreen: leave a 1rem gutter so the rounded edge + shadow read
        // as a layer over the table behind, not as a permanent page.
        'h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] rounded-xl'

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
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
        className={`relative flex ${sizing} flex-col overflow-hidden bg-cream shadow-2xl ring-1 ring-warm`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
  return createPortal(modal, document.body)
}
