/**
 * UpdateBanner tests — pin the user-facing contract for "we noticed a
 * newer SDK is available; here's the command to upgrade":
 *
 *   - Only admins see it (domain experts can't run `pnpm update`).
 *   - It only renders when the API reports hasUpdate=true.
 *   - The dismiss button hides it for the rest of the session AND
 *     stores the target version in sessionStorage so the banner
 *     doesn't bounce back if the dashboard re-mounts.
 *   - When the target version bumps (npm publishes a newer release
 *     after the user dismissed an older one), the banner reappears.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UpdateBanner } from './UpdateBanner'

const VERSION_ENDPOINT = '/admin/ai/api/version'

type VersionBody = {
  current: string
  latest: string | null
  hasUpdate: boolean
  packageManager?: string
  language?: 'ts' | 'python'
}

function mockVersion(body: VersionBody) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.endsWith(VERSION_ENDPOINT)) {
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}


beforeEach(() => {
  sessionStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('UpdateBanner', () => {
  it('renders the upgrade banner with the command on loopback', async () => {
    mockVersion({
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      packageManager: 'pnpm',
      language: 'ts',
    })
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={true} loopback={true} />)
    await waitFor(() =>
      expect(screen.getByText(/Update available/i)).toBeInTheDocument(),
    )
    // Banner header shows "current → latest". Match the literal arrow
    // so we don't collide with the same version string in the copy
    // command below.
    expect(screen.getByText(/0\.1\.0\s*→\s*0\.2\.0/)).toBeInTheDocument()
    expect(
      screen.getByText('pnpm update @artanis-ai/gravel@0.2.0'),
    ).toBeInTheDocument()
  })

  it('renders the correct command for the detected package manager', async () => {
    mockVersion({
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      packageManager: 'bun',
      language: 'ts',
    })
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={true} loopback={true} />)
    expect(
      await screen.findByText('bun update @artanis-ai/gravel@0.2.0'),
    ).toBeInTheDocument()
  })

  it('renders the Python upgrade command when language=python', async () => {
    mockVersion({
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      packageManager: 'uv',
      language: 'python',
    })
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={true} loopback={true} />)
    expect(
      await screen.findByText('uv add artanis-gravel@0.2.0'),
    ).toBeInTheDocument()
  })

  it('on a non-loopback host, shows the "ask your developer" copy instead of a command', async () => {
    mockVersion({
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      packageManager: 'pnpm',
      language: 'ts',
    })
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={true} loopback={false} />)
    await waitFor(() =>
      expect(screen.getByText(/Update available/i)).toBeInTheDocument(),
    )
    expect(
      screen.getByText(/Ask your developer to update the Gravel SDK and redeploy\./i),
    ).toBeInTheDocument()
    // Misleading command must NOT appear on prod.
    expect(screen.queryByText(/pnpm update/)).not.toBeInTheDocument()
    expect(screen.queryByText(/@artanis-ai\/gravel@/)).not.toBeInTheDocument()
  })

  it('does not render for non-admin users even if an update is available', async () => {
    const fetchSpy = mockFetchSpy({
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
    })
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={false} />)
    // Give the effect a chance — it shouldn't even fire for non-admin.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/Update available/i)).not.toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not render when hasUpdate=false', async () => {
    mockVersion({ current: '0.2.0', latest: '0.2.0', hasUpdate: false })
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={true} />)
    // Wait long enough that the effect would've fired + completed.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/Update available/i)).not.toBeInTheDocument()
  })

  it('does not render when the API fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={true} />)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/Update available/i)).not.toBeInTheDocument()
  })

  it('dismiss hides the banner and persists the target version to sessionStorage', async () => {
    mockVersion({ current: '0.1.0', latest: '0.2.0', hasUpdate: true })
    const user = userEvent.setup()
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={true} />)
    const dismiss = await screen.findByRole('button', { name: /dismiss update notice/i })
    await user.click(dismiss)
    expect(screen.queryByText(/Update available/i)).not.toBeInTheDocument()
    expect(sessionStorage.getItem('gravel:update-banner:dismissed-version')).toBe('0.2.0')
  })

  it('stays dismissed for the same target version across remounts', async () => {
    sessionStorage.setItem('gravel:update-banner:dismissed-version', '0.2.0')
    mockVersion({ current: '0.1.0', latest: '0.2.0', hasUpdate: true })
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={true} />)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/Update available/i)).not.toBeInTheDocument()
  })

  it('reappears when a newer target version is published', async () => {
    // Earlier dismissal was for 0.2.0; npm now serves 0.3.0.
    sessionStorage.setItem('gravel:update-banner:dismissed-version', '0.2.0')
    mockVersion({ current: '0.1.0', latest: '0.3.0', hasUpdate: true })
    render(<UpdateBanner mountPath="/admin/ai" isAdmin={true} />)
    expect(await screen.findByText(/Update available/i)).toBeInTheDocument()
    expect(screen.getByText('pnpm update @artanis-ai/gravel@0.3.0')).toBeInTheDocument()
  })
})

function mockFetchSpy(body: { current: string; latest: string | null; hasUpdate: boolean }) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200 }),
  )
}
