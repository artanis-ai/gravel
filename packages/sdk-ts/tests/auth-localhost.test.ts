/**
 * Localhost = admin behavior. The browser-facing hostname (X-Forwarded-Host
 * ?? Host) drives the decision; view-as still demotes; opt-out via
 * `localhostIsAdmin: false`.
 */
import { describe, expect, it } from 'vitest'

import { authenticate } from '../src/auth/index.js'
import { isLocalhostRequest, browserFacingHostname } from '../src/auth/origin.js'
import type { GravelRequest, ResolvedGravelConfig } from '../src/types.js'

function mkReq(headers: Record<string, string>, cookies: Record<string, string> = {}): GravelRequest {
  const h = new Headers(headers)
  return {
    url: 'http://localhost/admin/ai',
    method: 'GET',
    headers: h,
    cookies: new Map(Object.entries(cookies)),
  }
}

function mkConfig(extra: Partial<ResolvedGravelConfig> = {}): ResolvedGravelConfig {
  return {
    mountPath: '/admin/ai',
    productName: '',
    database: { url: 'file:./test.db', tablePrefix: 'gravel_' },
    auth: { defaultPassword: 'pw-very-long-and-test-only' },
    environments: ['prod'],
    hideArtanisBranding: false,
    localhostIsAdmin: true,
    evals: { concurrency: { trace: 5, live: 2 }, judgeVersion: 'auto' },
    ...extra,
  }
}

describe('isLocalhostRequest', () => {
  it.each([
    ['localhost', true],
    ['localhost:3000', true],
    ['127.0.0.1', true],
    ['127.0.0.1:8080', true],
    ['127.55.66.77', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['my-app.localhost', true],
    ['example.com', false],
    ['10.0.0.5', false],
    ['192.168.1.42', false],
    ['gravel.artanis.ai', false],
  ])('host=%s → %s', (host, expected) => {
    expect(isLocalhostRequest(mkReq({ host }))).toBe(expected)
  })

  it('prefers X-Forwarded-Host over Host (proxy boundary)', () => {
    // Behind nginx serving example.com, server-side Host is 127.0.0.1.
    // Browser sees example.com, so we should NOT treat as localhost.
    expect(
      isLocalhostRequest(
        mkReq({ host: '127.0.0.1', 'x-forwarded-host': 'example.com' }),
      ),
    ).toBe(false)
  })

  it('takes the leftmost entry of a comma-separated X-Forwarded-Host', () => {
    expect(
      isLocalhostRequest(
        mkReq({ 'x-forwarded-host': 'localhost, internal-proxy:8080' }),
      ),
    ).toBe(true)
  })

  it('returns null hostname when both headers missing', () => {
    expect(browserFacingHostname(mkReq({}))).toBe(null)
  })
})

describe('authenticate · localhost shortcut', () => {
  it('returns admin without any cookie when host is localhost', async () => {
    const out = await authenticate(mkConfig(), mkReq({ host: 'localhost:3000' }))
    expect(out).toEqual({
      kind: 'authed',
      user: { id: 'localhost', firstName: 'Developer', role: 'admin' },
    })
  })

  it('demotes to user when view-as cookie is set (localhost preview)', async () => {
    const out = await authenticate(
      mkConfig(),
      mkReq({ host: 'localhost:3000' }, { gravel_view_as: 'user' }),
    )
    expect(out).toMatchObject({
      kind: 'authed',
      user: { role: 'user' },
    })
  })

  it('does NOT short-circuit when localhostIsAdmin is false', async () => {
    const out = await authenticate(
      mkConfig({ localhostIsAdmin: false }),
      mkReq({ host: 'localhost:3000' }),
    )
    // Falls through to password mode; no session cookie → unauthed.
    expect(out).toEqual({ kind: 'unauthed-password', reason: 'no-session' })
  })

  it('does NOT short-circuit on non-localhost', async () => {
    const out = await authenticate(mkConfig(), mkReq({ host: 'gravel.artanis.ai' }))
    expect(out).toEqual({ kind: 'unauthed-password', reason: 'no-session' })
  })

  it('localhost short-circuit applies even with getUser configured (dev convenience)', async () => {
    const out = await authenticate(
      mkConfig({
        auth: {
          getUser: async () => ({ id: 'real-user', firstName: 'Real', role: 'user' }),
        },
      }),
      mkReq({ host: '127.0.0.1' }),
    )
    expect(out).toEqual({
      kind: 'authed',
      user: { id: 'localhost', firstName: 'Developer', role: 'admin' },
    })
  })
})
