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
  { path: '/prompts', label: 'Prompts' },
  { path: '/traces', label: 'Traces' },
  { path: '/datasets', label: 'Datasets' },
  { path: '/evals', label: 'Evals' },
  { path: '/analysis', label: 'Analysis' },
  { path: '/settings', label: 'Settings', adminOnly: true },
]

export function Layout({ children, user }: { children: ReactNode; user?: User }) {
  const [location] = useLocation()
  const isAdmin = user?.role === 'admin'
  // Show productName only if the host configured one. With nothing set,
  // the header chrome is fully neutral — no "G" logo, no "Gravel"
  // wordmark — so the embedded dashboard reads as part of the host
  // app to the domain experts logging in.
  const productName = window.__GRAVEL_PRODUCT_NAME__?.trim() || ''

  const mountPath = window.__GRAVEL_MOUNT_PATH__ ?? ''

  return (
    <div className="min-h-screen flex flex-col">
      <UpdateBanner mountPath={mountPath} isAdmin={isAdmin} />
      <header className="border-b border-warm bg-cream/95 backdrop-blur-sm sticky top-0 z-40">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {productName ? (
              <span className="font-display font-semibold text-sm">{productName}</span>
            ) : null}
          </div>
          {user && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-text-mid">Hi, {user.firstName}</span>
              {isAdmin && <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">Admin</span>}
            </div>
          )}
        </div>
      </header>

      <div className="flex-1 flex">
        <aside className="w-52 border-r border-warm p-4 hidden sm:block">
          <nav className="space-y-1 text-sm">
            {NAV_ITEMS.filter((i) => !i.adminOnly || isAdmin).map((item) => {
              const active = location.startsWith(item.path)
              return (
                <Link key={item.path} href={item.path}>
                  <a className={`block rounded-lg px-2.5 py-1.5 ${active ? 'bg-primary/10 text-primary font-medium' : 'text-text-mid hover:bg-warm'}`}>
                    {item.label}
                  </a>
                </Link>
              )
            })}
          </nav>
        </aside>
        <main className="flex-1 p-6 sm:p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
