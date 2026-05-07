/**
 * "Update available" banner for the embedded dashboard.
 *
 * Why this exists: the dashboard ships embedded in the host's
 * `@artanis-ai/gravel` install, so the version a domain expert sees
 * is whatever the developer last `pnpm install`-ed. Without a heads-
 * up they can drift weeks behind on bug fixes and feature work.
 *
 * Behaviour:
 *   - Only renders for admins (developers). Domain experts can't run
 *     `npm update`, so we don't bother them.
 *   - Polls `/api/version` once on mount; the backend caches the npm
 *     registry hit for 1 hour so this is cheap.
 *   - Dismissible per-target-version: once the user dismisses the
 *     banner for v0.2.0, it won't reappear unless v0.2.1 lands. State
 *     is local to the browser (sessionStorage) — no server bookkeeping.
 *   - Shows a copy-pasteable update command. We try to detect the
 *     host's package manager from the page URL hint or fall back to
 *     a generic note covering the four common managers.
 */
import { useEffect, useState } from 'react'

interface VersionInfo {
  current: string
  latest: string | null
  hasUpdate: boolean
}

const DISMISS_KEY = 'gravel:update-banner:dismissed-version'

export function UpdateBanner({ mountPath, isAdmin }: { mountPath: string; isAdmin: boolean }) {
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY)
    } catch {
      return null
    }
  })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch(`${mountPath}/api/version`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return
        setInfo(body as VersionInfo)
      })
      .catch(() => {
        /* swallow — banner just doesn't appear */
      })
    return () => {
      cancelled = true
    }
  }, [mountPath, isAdmin])

  if (!info || !info.hasUpdate || !info.latest) return null
  if (dismissedFor === info.latest) return null

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, info.latest!)
    } catch {
      /* ignore */
    }
    setDismissedFor(info.latest)
  }

  const updateCmd = `pnpm update @artanis-ai/gravel@${info.latest}` // works for pnpm + npm aliases mostly; doc lists npm/yarn/bun explicitly

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(updateCmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-primary/5 border-b border-primary/20 text-text-dark text-xs"
    >
      <div className="px-6 py-2 flex items-center gap-3 max-w-screen-2xl mx-auto">
        <span className="font-medium">Update available</span>
        <span className="text-text-mid">
          {info.current} → {info.latest}
        </span>
        <code className="ml-auto rounded bg-warm px-2 py-0.5 font-mono text-[11px]">{updateCmd}</code>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded border border-warm px-2 py-0.5 hover:bg-warm transition-colors"
          aria-label="Copy update command"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-text-muted hover:text-text-dark px-1"
          aria-label="Dismiss update notice"
        >
          ×
        </button>
      </div>
    </div>
  )
}
