import { Link, useLocation } from 'wouter'
import type { ReactNode } from 'react'
import { UpdateBanner } from './UpdateBanner'

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

// Three tabs the domain expert understands. "Traces" was a developer-
// shaped word; "Outputs" is what the AI produced. "Review" is where
// flagged outputs go for inspection (folds in Datasets + Evals — they
// are the same workflow from the DE's perspective). "Prompts" is the
// manifest editor.
const NAV_ITEMS = [
  // `/` is rendered by App.tsx as the prompts page; treat it as part of
  // the Prompts tab so the highlight is correct on first load.
  { path: '/prompts', label: 'Prompts', match: ['/', '/prompts'] },
  { path: '/traces', label: 'Outputs', match: ['/traces'] },
  { path: '/review', label: 'Review', match: ['/review', '/datasets', '/evals'] },
]

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
    <div className="min-h-screen flex flex-col">
      <UpdateBanner mountPath={mountPath} isAdmin={isAdmin} />
      <div className="flex-1 flex">
        <aside className="w-52 border-r border-warm hidden sm:flex sm:flex-col">
          {productName ? (
            <div className="px-4 pt-4 pb-3 border-b border-warm">
              <span className="font-display font-semibold text-sm text-text-dark">{productName}</span>
            </div>
          ) : null}
          <nav className="flex-1 p-4 space-y-1 text-sm">
            {NAV_ITEMS.map((item) => {
              const active = isActive(location, item.match)
              return (
                <Link key={item.path} href={item.path}>
                  <a
                    className={`block rounded-lg px-2.5 py-1.5 cursor-pointer ${
                      active
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-text-mid hover:bg-warm'
                    }`}
                  >
                    {item.label}
                  </a>
                </Link>
              )
            })}
          </nav>
          {/*
            No "Hi, {name}" footer. The dashboard is embedded chrome
            inside the host app — a domain expert who's already logged
            into the host doesn't need to be reminded who they are. The
            only place we surface their identity is on the PR they
            submit, where it actually carries information.

            Sign out: not present here either. For real users, logout
            belongs to the HOST app's auth UI, not the embed. For
            localhost devs, the auth gate auto-elevates regardless, so
            a button would just visually flicker.
          */}
        </aside>
        <main className="flex-1 p-6 sm:p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
