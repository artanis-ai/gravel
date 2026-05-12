import { Link, useLocation } from 'wouter'
import type { ReactElement, ReactNode } from 'react'
import { UpdateBanner } from './UpdateBanner'
import { PendingMigrationsBanner } from './PendingMigrationsBanner'

declare global {
  interface Window {
    __GRAVEL_PRODUCT_NAME__?: string
    __GRAVEL_MOUNT_PATH__?: string
  }
}

interface User {
  id: string
  firstName: string
  role: 'user' | 'admin'
}

// Two tabs. "Prompts" is the manifest editor; "Review" is the queue of
// AI samples the domain expert flags / corrects (one row = one sample
// = one input/output exchange). The route stays /samples because that's
// what the SDK serves; the label is what the DE actually thinks about
// they're doing here.
const NAV_ITEMS: NavItem[] = [
  // `/` is rendered by App.tsx as the prompts page; treat it as part of
  // the Prompts tab so the highlight is correct on first load.
  { path: '/prompts', label: 'Prompts', match: ['/', '/prompts'], icon: PromptsIcon },
  { path: '/samples', label: 'Review', match: ['/samples'], icon: ReviewIcon },
]

interface NavItem {
  path: string
  label: string
  match: string[]
  icon: (props: { className?: string }) => ReactElement
}

function isActive(location: string, prefixes: string[]): boolean {
  return prefixes.some((p) => (p === '/' ? location === '/' : location === p || location.startsWith(p + '/')))
}

export function Layout({ children, user }: { children: ReactNode; user?: User }) {
  const [location] = useLocation()
  const isAdmin = user?.role === 'admin'
  // Show productName only if the host configured one. With nothing set,
  // the chrome stays neutral so the embedded surface reads as part of
  // the host app to the domain expert reviewing AI output.
  const productName = window.__GRAVEL_PRODUCT_NAME__?.trim() || ''
  const mountPath = window.__GRAVEL_MOUNT_PATH__ ?? ''

  return (
    <div className="h-screen flex flex-col">
      <UpdateBanner mountPath={mountPath} isAdmin={isAdmin} />
      <PendingMigrationsBanner mountPath={mountPath} isAdmin={isAdmin} />
      <header className="bg-cream">
        <div className="flex flex-col items-center gap-2 px-4 py-4 sm:px-6">
          {productName ? (
            <span className="font-display text-xs font-medium uppercase tracking-wide text-text-muted">
              {productName}
            </span>
          ) : null}
          <Tabs location={location} />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-6 pt-3 sm:px-8 sm:pb-8 sm:pt-3">{children}</div>
      </main>
    </div>
  )
}

/**
 * Segmented-control tab bar — the rounded pill with the active tab
 * as a raised white card. Matches the iOS / macOS segmented-control
 * pattern; reads as one cohesive choice rather than three separate
 * links so the DE doesn't have to wonder "where am I."
 */
function Tabs({ location }: { location: string }) {
  return (
    <nav
      className="inline-flex items-center gap-1 rounded-2xl bg-warm/80 p-1 text-sm"
      role="tablist"
      aria-label="Sections"
    >
      {NAV_ITEMS.map((item) => {
        const active = isActive(location, item.match)
        const Icon = item.icon
        return (
          <Link key={item.path} href={item.path}>
            <a
              role="tab"
              aria-selected={active}
              className={
                'inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-1.5 font-medium transition-colors ' +
                (active
                  ? 'bg-cream text-text-dark shadow-sm ring-1 ring-warm'
                  : 'text-text-mid hover:text-text-dark')
              }
            >
              <Icon className={active ? 'text-text-dark' : 'text-text-muted'} />
              {item.label}
            </a>
          </Link>
        )
      })}
    </nav>
  )
}

// Inline SVG icons — kept tiny and tonally matched to the brand. Using
// stroke-based glyphs (1.75 weight) so they sit visually with the
// existing lock icon on the login page + the eye on DeveloperNote.

function iconClass(extra?: string): string {
  return `h-4 w-4 ${extra ?? ''}`.trim()
}

function PromptsIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={iconClass(className)}
    >
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="14 3 14 9 20 9" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  )
}

function ReviewIcon({ className }: { className?: string }) {
  // Magnifier over a document — "look closely at AI output", which is
  // the actual job of the Review tab.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={iconClass(className)}
    >
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
      <polyline points="14 3 14 9 20 9" />
      <circle cx="17" cy="17" r="3" />
      <line x1="19.2" y1="19.2" x2="22" y2="22" />
    </svg>
  )
}

