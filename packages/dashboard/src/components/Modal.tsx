import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Centred modal — backdrop click + Escape close. Renders via a portal
 * to `document.body` so `fixed inset-0` is anchored to the viewport
 * regardless of any transform / filter / backdrop-blur ancestor that
 * would otherwise turn the modal into a containing-block-scoped element
 * (visible as a backdrop with a "margin" of page leaking around it).
 */
export type ModalSize = 'md' | 'lg' | 'xl' | '2xl' | '3xl'

const SIZE_CLASS: Record<ModalSize, string> = {
  md: 'max-w-lg',
  lg: 'max-w-xl',
  xl: 'max-w-2xl',
  '2xl': 'max-w-4xl',
  '3xl': 'max-w-6xl',
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  size?: ModalSize
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Lock body scroll while the modal is up (matches Dialog).
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-text-dark/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className={`flex max-h-[90vh] w-full flex-col rounded-2xl bg-cream shadow-2xl ring-1 ring-warm ${SIZE_CLASS[size]}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-warm px-5 py-3">
          <h2 className="font-display font-semibold text-text-dark">{title}</h2>
          <button
            type="button"
            className="cursor-pointer rounded-md p-1 text-text-muted hover:bg-warm hover:text-text-dark"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-warm px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
  return createPortal(modal, document.body)
}
