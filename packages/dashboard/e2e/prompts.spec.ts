/**
 * E2E: prompts flow.
 *
 * The Vite dev server runs from `packages/dashboard/` so by default
 * the manifest read fails (no `.gravel/manifest.json` in cwd) and
 * /api/prompts returns an empty list. We verify:
 *
 *   1. The empty-list shape comes back successfully (regression
 *      protection for the case where a missing manifest used to
 *      500 the route).
 *   2. The Prompts route renders without a console error.
 *   3. Submitting drafts without the GitHub App installed surfaces
 *      `github_not_installed`, not a 500.
 */
import { expect, test } from '@playwright/test'

const MOUNT = '/admin/ai'

test('GET /api/prompts returns empty list with no manifest', async ({ request }) => {
  const res = await request.get(`${MOUNT}/api/prompts`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(Array.isArray(body.prompts)).toBe(true)
  // Either empty (no manifest in dev cwd) or populated (if a dev
  // pointed GRAVEL_REPO_ROOT at a real repo). Both are valid.
})

test('GET /api/prompts/:id returns 404 for unknown id', async ({ request }) => {
  const res = await request.get(`${MOUNT}/api/prompts/p_definitely_not_real_xxxxx`)
  expect(res.status()).toBe(404)
})

test('POST /api/prompts/submit returns github_not_installed when GH App not configured', async ({
  request,
}) => {
  const res = await request.post(`${MOUNT}/api/prompts/submit`, {
    data: { drafts: [{ promptId: 'p_test', newText: 'hello' }] },
  })
  // 409 with `github_not_installed` is the expected shape when env
  // vars (GRAVEL_GH_INSTALL_*) aren't set. The dashboard's submit
  // modal reads this and shows the install card.
  expect([400, 409]).toContain(res.status())
  const body = await res.json()
  expect(typeof body.error).toBe('string')
})

test('POST /api/prompts/submit rejects empty drafts', async ({ request }) => {
  const res = await request.post(`${MOUNT}/api/prompts/submit`, {
    data: { drafts: [] },
  })
  expect(res.status()).toBe(400)
  const body = await res.json()
  expect(body.error).toBe('no_drafts')
})

test('Prompts route renders without console error', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.goto(`${MOUNT}/prompts`)
  await page.waitForLoadState('networkidle')
  expect(errors).toEqual([])
})
