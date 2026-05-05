import { Link, useLocation } from 'wouter'
import type { ReactNode } from 'react'

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

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-warm bg-cream/95 backdrop-blur-sm sticky top-0 z-40">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-white text-xs font-bold">G</span>
            </div>
            <span className="font-display font-semibold text-sm">Gravel</span>
            <span className="text-xs text-text-muted ml-2 px-2 py-0.5 rounded-full bg-warm">Skeleton</span>
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
