/**
 * Pending-migrations banner. Sits next to UpdateBanner at the top of
 * the dashboard chrome and warns the admin when the DB has fewer
 * migrations applied than the SDK ships.
 *
 * Why:
 *   - In prod, an SDK upgrade that ships a new migration silently
 *     breaks at first-query time (missing column) unless the deploy
 *     pipeline ran `npx @artanis-ai/gravel migrate`. This banner is
 *     the loudest pre-deploy signal we have.
 *   - In dev, auto-migrate is on by default — but if the user
 *     disabled it (GRAVEL_DISABLE_AUTO_MIGRATE=1) or auto-migrate
 *     failed (broken local DB state), they'd never know without
 *     this surface.
 *
 * Behaviour:
 *   - Admin-only (the count is part of the ops surface).
 *   - Polls once on mount; backend response includes whether
 *     auto-migrate is active so we can tailor the copy.
 *   - No dismissal: schema gaps don't get less bad with time. If you
 *     find this annoying, run the migrate command.
 *   - Per-stack upgrade command derived from the version endpoint
 *     (we re-fetch /api/version because the package-manager
 *     detection lives there; both calls are cached server-side).
 */
import { useEffect, useState } from 'react'
import { CopyableCode } from './CopyableCode'

interface MigrationsStatus {
  pending: number
  dialect: 'sqlite' | 'postgres' | null
  autoMigrate: boolean
}

interface VersionInfo {
  packageManager?: string
  language?: 'ts' | 'python'
}

function migrateCommand(_v: VersionInfo): string {
  // The CLI binary is installed via install.sh and lives on PATH
  // regardless of host language or package manager. Both TS and Python
  // hosts surface the same command.
  return 'gravel migrate'
}

export function PendingMigrationsBanner({
  mountPath,
  isAdmin,
}: {
  mountPath: string
  isAdmin: boolean
}) {
  const [status, setStatus] = useState<MigrationsStatus | null>(null)
  const [version, setVersion] = useState<VersionInfo | null>(null)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    Promise.all([
      fetch(`${mountPath}/api/migrations/status`, { credentials: 'same-origin' }).then((r) =>
        r.ok ? r.json() : null,
      ),
      fetch(`${mountPath}/api/version`, { credentials: 'same-origin' }).then((r) =>
        r.ok ? r.json() : null,
      ),
    ])
      .then(([s, v]) => {
        if (cancelled) return
        if (s) setStatus(s as MigrationsStatus)
        if (v) setVersion(v as VersionInfo)
      })
      .catch(() => {
        /* swallow — banner just doesn't appear */
      })
    return () => {
      cancelled = true
    }
  }, [mountPath, isAdmin])

  if (!status || status.pending <= 0) return null

  const cmd = migrateCommand(version ?? {})
  const detail = status.autoMigrate
    ? 'Auto-migrate is on but did not complete. Run the command below to retry.'
    : 'Auto-migrate is off. Run the command below to apply them.'

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-primary/10 border-b border-primary/30 text-text-dark text-xs"
      data-testid="pending-migrations-banner"
    >
      <div className="px-6 py-2 flex flex-wrap items-center gap-3 max-w-screen-2xl mx-auto">
        <span className="font-medium">
          {status.pending} pending DB migration{status.pending === 1 ? '' : 's'}
        </span>
        <span className="text-text-mid">{detail}</span>
        <span className="ml-auto">
          <CopyableCode>{cmd}</CopyableCode>
        </span>
      </div>
    </div>
  )
}
