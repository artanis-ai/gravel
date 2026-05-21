/**
 * Tiny event-driven toast system.
 *
 * No context provider, no portals: a single `<Toaster />` mounted at
 * the app root listens for a custom `gravel:toast` window event and
 * renders the toast stack. Callers anywhere in the tree fire
 * `toast('Saved')` without needing to be a descendant of any
 * provider. Lighter-weight than the alternatives (react-toastify /
 * sonner / etc.) for the handful of moments where we need to flash
 * "done" without a modal.
 *
 * Tones: `info` (default neutral) / `success` (forest tint) /
 * `error` (rose tint). Auto-dismisses after `durationMs` (default
 * 3000); click X or press Escape to dismiss early.
 */
import { useCallback, useEffect, useState } from 'react'

export type ToastTone = 'info' | 'success' | 'error'

interface ToastSpec {
  id: number
  message: string
  tone: ToastTone
  durationMs: number
}

interface ToastDetail {
  message: string
  tone?: ToastTone
  durationMs?: number
}

const EVENT_NAME = 'gravel:toast'

export function toast(message: string, opts: { tone?: ToastTone; durationMs?: number } = {}) {
  if (typeof window === 'undefined') return
  const detail: ToastDetail = { message, tone: opts.tone, durationMs: opts.durationMs }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }))
}

let nextId = 1

export function Toaster() {
  const [toasts, setToasts] = useState<ToastSpec[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  useEffect(() => {
    function onToast(e: Event) {
      const ce = e as CustomEvent<ToastDetail>
      const spec: ToastSpec = {
        id: nextId++,
        message: ce.detail.message,
        tone: ce.detail.tone ?? 'info',
        durationMs: ce.detail.durationMs ?? 3000,
      }
      setToasts((prev) => [...prev, spec])
      window.setTimeout(() => dismiss(spec.id), spec.durationMs)
    }
    window.addEventListener(EVENT_NAME, onToast)
    return () => window.removeEventListener(EVENT_NAME, onToast)
  }, [dismiss])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && toasts.length > 0) setToasts([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toasts.length])

  if (toasts.length === 0) return null
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={
            'pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border px-3.5 py-2.5 text-sm shadow-md ' +
            (t.tone === 'success'
              ? 'border-forest/30 bg-forest/10 text-forest'
              : t.tone === 'error'
                ? 'border-rose-200 bg-rose-50 text-rose-800'
                : 'border-slate-200 bg-white text-slate-800')
          }
          role="status"
          data-testid="toast"
          data-tone={t.tone}
        >
          <span className="flex-1">{t.message}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            className="cursor-pointer text-text-muted hover:text-text-dark"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
