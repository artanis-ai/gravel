/**
 * "Update available" banner for the embedded dashboard.
 *
 * Why this exists: the dashboard ships embedded in the host's
 * `@artanis-ai/gravel` install, so the version a domain expert sees
 * is whatever the developer last installed. Without a heads-up they
 * can drift weeks behind on bug fixes and feature work.
 *
 * Audience split (the key UX decision):
 *
 *   - On **loopback** (the browser hostname is `localhost`, `127.0.0.1`,
 *     or `::1`) we assume the viewer is the developer in their dev
 *     environment. We render the actionable copy-pasteable update
 *     command for whichever package manager the SDK detected at the
 *     host's lockfile (pnpm/npm/yarn/bun/uv/pip/...).
 *
 *   - On **anything else** (the prod URL the customer accesses via
 *     their auth) the viewer is a domain expert (clinician, analyst,
 *     lawyer, …) or an operator who can't run a package manager
 *     against the prod box anyway. Showing them a command would be
 *     misleading. We render an informational variant that names the
 *     gap and tells them to hand it back to their developer, mirroring
 *     the GH-not-connected dialog.
 *
 * Both variants are admin-only — non-admin viewers see nothing, just
 * like before, because the version mismatch isn't their concern.
 *
 * Other behaviours:
 *   - Polls `/api/version` once on mount; backend caches npm registry
 *     hit for 1 hour so this is cheap.
 *   - Dismissible per-target-version via sessionStorage; reappears
 *     when a newer release lands.
 */
import { useEffect, useState } from 'react'
import { CopyableCode } from './CopyableCode'

interface VersionInfo {
  current: string
  latest: string | null
  hasUpdate: boolean
  /** Detected from the host's lockfile (pnpm/npm/yarn/bun/uv/pip/...). */
  packageManager?: PackageManager
  /** 'ts' for the JS/TS SDK, 'python' for the Python SDK. */
  language?: 'ts' | 'python'
}

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'uv' | 'pip' | 'poetry' | 'pipenv'

/**
 * Render the package-name + bump command for the detected stack. We
 * fall back to pnpm if the backend didn't report a manager — that's
 * the most common JS/TS host today and aligns with the docs.
 */
function updateCommand(info: VersionInfo): string {
  const pkg = info.language === 'python' ? 'artanis-gravel' : '@artanis-ai/gravel'
  const target = info.latest ?? 'latest'
  switch (info.packageManager) {
    case 'npm':
      return `npm install ${pkg}@${target}`
    case 'yarn':
      return `yarn upgrade ${pkg}@${target}`
    case 'bun':
      return `bun update ${pkg}@${target}`
    case 'uv':
      return `uv pip install --upgrade ${pkg}==${target}`
    case 'poetry':
      return `poetry add ${pkg}@${target}`
    case 'pipenv':
      return `pipenv update ${pkg}`
    case 'pip':
      return `pip install --upgrade ${pkg}==${target}`
    case 'pnpm':
    default:
      return `pnpm update ${pkg}@${target}`
  }
}

function isLoopbackHost(): boolean {
  try {
    const h = window.location.hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
  } catch {
    return false
  }
}

const DISMISS_KEY = 'gravel:update-banner:dismissed-version'

export function UpdateBanner({
  mountPath,
  isAdmin,
  /**
   * When true, the dashboard is being viewed from the developer's
   * dev box (browser hostname is loopback) and the upgrade command
   * is actionable. When false, swap to "ask your developer" copy.
   * Defaults to detecting from `window.location.hostname`, but tests
   * pass it explicitly because jsdom rejects redefining location.
   */
  loopback,
}: {
  mountPath: string
  isAdmin: boolean
  loopback?: boolean
}) {
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY)
    } catch {
      return null
    }
  })

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

  const onLoopback = loopback ?? isLoopbackHost()

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-primary/5 border-b border-primary/20 text-text-dark text-xs"
      data-testid="update-banner"
    >
      <div className="px-6 py-2 flex items-center gap-3 max-w-screen-2xl mx-auto">
        <span className="font-medium">Update available</span>
        <span className="text-text-mid">
          {info.current} → {info.latest}
        </span>
        {onLoopback ? (
          <span className="ml-auto">
            <CopyableCode>{updateCommand(info)}</CopyableCode>
          </span>
        ) : (
          <span className="ml-auto text-text-mid">
            Ask your developer to update the Gravel SDK and redeploy.
          </span>
        )}
        <button
          type="button"
          onClick={handleDismiss}
          className="text-text-muted hover:text-text-dark px-1 cursor-pointer"
          aria-label="Dismiss update notice"
        >
          ×
        </button>
      </div>
    </div>
  )
}
