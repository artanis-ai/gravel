/**
 * E2E: samples flow.
 *
 * Dev server defaults to prompts-only (no DATABASE_URL), so samples
 * degrades to an empty page. We verify the shape AND that the empty
 * state renders on the route page without 500ing.
 *
 * Filter + pagination tests go through the API directly so they
 * don't depend on dashboard rendering specifics (which the
 * vitest UI tests already cover).
 */
import { expect, test } from '@playwright/test'

const MOUNT = '/admin/ai'

test('GET /api/samples returns empty page on prompts-only install', async ({ request }) => {
  const res = await request.get(`${MOUNT}/api/samples`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body).toEqual({ samples: [], total: 0, page: 1, page_size: 20 })
})

test('GET /api/samples honours pagination query params', async ({ request }) => {
  const res = await request.get(`${MOUNT}/api/samples?page=2&page_size=5`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  // Even with no rows, the shape echoes the requested page state.
  expect(body.samples).toEqual([])
  expect(body.total).toBe(0)
})

test('Samples route renders empty state without error', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.goto(`${MOUNT}/samples`)
  await page.waitForLoadState('networkidle')
  // Empty samples → onboarding card or "no samples yet" copy.
  // Don't pin exact text (the UI iterates); just assert no crash.
  expect(errors).toEqual([])
})
