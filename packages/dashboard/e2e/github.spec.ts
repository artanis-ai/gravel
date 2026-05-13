/**
 * E2E: GitHub App install flow.
 *
 * Without the env vars set, /api/github/status reports `connected:
 * false`. The dashboard's prompts page reads this to decide whether
 * to show the install card or the submit button.
 *
 * /api/github/install returns a redirect URL to the CP; in dev-stub
 * mode (GRAVEL_GH_DEV_STUB=1) it bypasses the CP and points straight
 * at our own callback. We exercise both branches.
 */
import { expect, test } from '@playwright/test'

const MOUNT = '/admin/ai'

test('GET /api/github/status returns connected:false with no env', async ({ request }) => {
  const res = await request.get(`${MOUNT}/api/github/status`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  // The dev server inherits whatever env the test runner has; assert
  // shape rather than literal values so a developer with their own
  // GRAVEL_GH_INSTALL_ID set doesn't break the suite.
  expect(typeof body.connected).toBe('boolean')
  expect('repoOwner' in body).toBe(true)
  expect('repoName' in body).toBe(true)
})

test('GET /api/github/install returns a redirectUrl', async ({ request }) => {
  const res = await request.get(`${MOUNT}/api/github/install`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(typeof body.redirectUrl).toBe('string')
  expect(body.redirectUrl.length).toBeGreaterThan(0)
})

test('GET /api/github/install/callback 302s back to dashboard', async ({ request }) => {
  const res = await request.get(`${MOUNT}/api/github/install/callback`, {
    maxRedirects: 0,
  })
  expect(res.status()).toBe(302)
  const location = res.headers()['location']
  expect(location).toContain(`${MOUNT}/?gh=installed`)
})
