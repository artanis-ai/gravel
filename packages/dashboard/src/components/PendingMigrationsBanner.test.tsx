/**
 * Tests for PendingMigrationsBanner — the surface that warns an admin
 * when the host's DB is behind the SDK's bundled migrations. The
 * banner is the loudest pre-deploy signal we have for "you forgot
 * `gravel migrate`", so it has to be loud + correct.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PendingMigrationsBanner } from './PendingMigrationsBanner'

type Status = { pending: number; dialect: string | null; autoMigrate: boolean }
type Version = { packageManager?: string; language?: string }

function mock(routes: { status?: Status; version?: Version }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.endsWith('/api/migrations/status')) {
      return routes.status
        ? new Response(JSON.stringify(routes.status), { status: 200 })
        : new Response('null', { status: 404 })
    }
    if (url.endsWith('/api/version')) {
      return routes.version
        ? new Response(JSON.stringify(routes.version), { status: 200 })
        : new Response('null', { status: 404 })
    }
    return new Response('not found', { status: 404 })
  })
}

afterEach(() => vi.restoreAllMocks())

describe('PendingMigrationsBanner', () => {
  it('renders nothing when there are no pending migrations', async () => {
    mock({
      status: { pending: 0, dialect: 'sqlite', autoMigrate: true },
      version: { packageManager: 'pnpm', language: 'ts' },
    })
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
    mock({
      status: { pending: 3, dialect: 'postgres', autoMigrate: false },
      version: { packageManager: 'pnpm', language: 'ts' },
    })
    render(<PendingMigrationsBanner mountPath="/admin/ai" isAdmin={true} />)
    expect(await screen.findByText(/3 pending DB migrations/)).toBeInTheDocument()
    expect(screen.getByText(/Auto-migrate is off/i)).toBeInTheDocument()
    expect(screen.getByText('gravel migrate')).toBeInTheDocument()
  })

  it('renders the banner with the "auto-migrate failed" copy when auto-migrate is ON', async () => {
    mock({
      status: { pending: 1, dialect: 'sqlite', autoMigrate: true },
      version: { packageManager: 'pnpm', language: 'ts' },
    })
    render(<PendingMigrationsBanner mountPath="/admin/ai" isAdmin={true} />)
    expect(await screen.findByText(/1 pending DB migration\b/)).toBeInTheDocument()
    expect(screen.getByText(/Auto-migrate is on but did not complete/i)).toBeInTheDocument()
  })

  it('renders the same `gravel migrate` command on a Python host (the binary is on PATH, stack-agnostic)', async () => {
    mock({
      status: { pending: 2, dialect: 'sqlite', autoMigrate: false },
      version: { packageManager: 'uv', language: 'python' },
    })
    render(<PendingMigrationsBanner mountPath="/admin/ai" isAdmin={true} />)
    expect(await screen.findByText('gravel migrate')).toBeInTheDocument()
  })
})
