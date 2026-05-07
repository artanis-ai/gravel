/**
 * Smoke E2E #2 — JSON API roundtrip with cookie auth.
 *
 * Asserts the SDK's HTTP surface answers what the dashboard SPA + the
 * spec promise: login -> /api/auth/me -> /api/prompts. Empty manifest
 * is the canonical fixture state, so the prompt list is `[]`.
 */
import { expect, test } from '@playwright/test'

const PASSWORD = process.env.GRAVEL_ADMIN_PASSWORD ?? 'e2e-test-password'

test.describe('API roundtrip', () => {
  test('login (JSON) -> /api/auth/me -> /api/prompts', async ({ request }) => {
    // 1. JSON login. Returns 200 + Set-Cookie. APIRequestContext stores
    //    the cookie automatically for subsequent calls.
    const loginRes = await request.post('/admin/ai/api/auth/login', {
      data: { password: PASSWORD },
      headers: { 'content-type': 'application/json' },
    })
    expect(loginRes.status(), 'JSON login should return 200').toBe(200)
    const setCookie = loginRes.headers()['set-cookie'] ?? ''
    expect(setCookie).toContain('gravel_session=')

    // 2. /api/auth/me returns the synthetic admin user + product/mount.
    const meRes = await request.get('/admin/ai/api/auth/me')
    expect(meRes.status()).toBe(200)
    const me = (await meRes.json()) as {
      user: { id: string; firstName: string; role: string }
      productName: string
      mountPath: string
      hideArtanisBranding: boolean
    }
    expect(me.user).toMatchObject({ id: 'admin', role: 'admin' })
    expect(typeof me.user.firstName).toBe('string')
    // productName defaults to '' so the dashboard chrome stays neutral
    // — the host opts INTO branding by setting `productName` in
    // gravel.config.ts. The e2e test-app deliberately doesn't set one.
    expect(me.productName).toBe('')
    expect(me.mountPath).toBe('/admin/ai')

    // 3. /api/prompts surfaces the (empty) manifest.
    const promptsRes = await request.get('/admin/ai/api/prompts')
    expect(promptsRes.status()).toBe(200)
    const prompts = (await promptsRes.json()) as {
      prompts: unknown[]
      last_scan_at: string | null
    }
    expect(prompts.prompts).toEqual([])
    expect(prompts.last_scan_at).toBeNull()
  })

  test('bad password is rejected with 401', async ({ request }) => {
    const res = await request.post('/admin/ai/api/auth/login', {
      data: { password: 'definitely-not-the-password' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status()).toBe(401)
  })

  test('unauthed /api/auth/me returns 401', async ({ request }) => {
    // Use a fresh request context with no stored cookies.
    const res = await request.get('/admin/ai/api/auth/me', {
      headers: { cookie: '' },
    })
    expect(res.status()).toBe(401)
  })
})
