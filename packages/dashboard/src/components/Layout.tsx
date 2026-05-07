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

const NAV_ITEMS = [
  // `/` is rendered by App.tsx as the prompts page; treat it as part of
  // the Prompts tab so the highlight is correct on first load (the
  // "tab not selected on initial render" bug surfaced by the demo).
  { path: '/prompts', label: 'Prompts', match: ['/', '/prompts'] },
  { path: '/traces', label: 'Traces', match: ['/traces'] },
  { path: '/datasets', label: 'Datasets', match: ['/datasets'] },
  { path: '/evals', label: 'Evals', match: ['/evals'] },
  { path: '/analysis', label: 'Analysis', match: ['/analysis'] },
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
          {user ? (
            <div className="border-t border-warm p-4 text-xs text-text-mid">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">Hi, {user.firstName}</span>
                {isAdmin ? (
                  <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                    Admin
                  </span>
                ) : null}
              </div>
              {/*
                Sign out is only meaningful when there's a real session to
                clear. On localhost the auth gate auto-elevates to admin
                regardless of cookie state, so a logout button there would
                visually flicker and re-admin on the next request — useless
                noise for the dev. The localhost shortcut tags the user
                with `id: 'localhost'`; everything else returns a real id.
              */}
              {user.id !== 'localhost' ? (
                <button
                  type="button"
                  onClick={async () => {
                    await fetch(`${mountPath}/api/auth/logout`, {
                      method: 'POST',
                      credentials: 'same-origin',
                    })
                    window.location.href = `${mountPath}/`
                  }}
                  className="mt-2 text-text-muted hover:text-text-dark cursor-pointer"
                  aria-label="Sign out"
                >
                  Sign out
                </button>
              ) : null}
            </div>
          ) : null}
        </aside>
        <main className="flex-1 p-6 sm:p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
