/**
 * Tests for PendingMigrationsBanner — the surface that warns an admin
 * when the host's DB is behind the SDK's bundled migrations. The
 * banner is the loudest pre-deploy signal we have for "you forgot to
 * run the migrate command", so it has to be loud + correct.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PendingMigrationsBanner } from './PendingMigrationsBanner'

type Status = { pending: number; dialect: string | null; autoMigrate: boolean }

function mockStatus(status: Status | null) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.endsWith('/api/migrations/status')) {
      return status
        ? new Response(JSON.stringify(status), { status: 200 })
        : new Response('null', { status: 404 })
    }
    return new Response('not found', { status: 404 })
  })
}

const originalRuntime = window.__GRAVEL_RUNTIME__
beforeEach(() => {
  delete window.__GRAVEL_RUNTIME__
})
afterEach(() => {
  vi.restoreAllMocks()
  window.__GRAVEL_RUNTIME__ = originalRuntime
})

describe('PendingMigrationsBanner', () => {
  it('renders nothing when there are no pending migrations', async () => {
    mockStatus({ pending: 0, dialect: 'sqlite', autoMigrate: true })
    render(<PendingMigrationsBanner mountPath="/admin/ai" isAdmin={true} />)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('pending-migrations-banner')).not.toBeInTheDocument()
  })

  it('renders nothing for non-admin viewers, regardless of pending count', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<PendingMigrationsBanner mountPath="/admin/ai" isAdmin={false} />)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('pending-migrations-banner')).not.toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('renders the banner with the right copy when auto-migrate is OFF', async () => {
    mockStatus({ pending: 3, dialect: 'postgres', autoMigrate: false })
    window.__GRAVEL_RUNTIME__ = 'typescript'
    render(<PendingMigrationsBanner mountPath="/admin/ai" isAdmin={true} />)
    expect(await screen.findByText(/3 pending DB migrations/)).toBeInTheDocument()
    expect(screen.getByText(/Auto-migrate is off/i)).toBeInTheDocument()
    expect(screen.getByText('npx @artanis-ai/gravel migrate')).toBeInTheDocument()
  })

  it('renders the banner with the "auto-migrate failed" copy when auto-migrate is ON', async () => {
    mockStatus({ pending: 1, dialect: 'sqlite', autoMigrate: true })
    window.__GRAVEL_RUNTIME__ = 'typescript'
    render(<PendingMigrationsBanner mountPath="/admin/ai" isAdmin={true} />)
    expect(await screen.findByText(/1 pending DB migration\b/)).toBeInTheDocument()
    expect(screen.getByText(/Auto-migrate is on but did not complete/i)).toBeInTheDocument()
  })

  it('emits the uvx form on Python hosts (matches how the user invoked the SDK in the first place)', async () => {
    mockStatus({ pending: 2, dialect: 'sqlite', autoMigrate: false })
    window.__GRAVEL_RUNTIME__ = 'python'
    render(<PendingMigrationsBanner mountPath="/admin/ai" isAdmin={true} />)
    expect(await screen.findByText('uvx --from artanis-gravel gravel migrate')).toBeInTheDocument()
  })
})
