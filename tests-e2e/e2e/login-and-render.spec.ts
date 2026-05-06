/**
 * Smoke E2E #1 — login flow + bundled SPA renders.
 *
 * Catches the obvious failure modes that unit tests can't:
 *   - HTML rewriting of `./assets/...` to `${mountPath}/_assets/...`
 *   - Asset content-type / 200 status
 *   - Auth cookie roundtrip end-to-end through a real browser
 *   - React actually mounts and paints something into `#root`
 */
import { expect, test } from '@playwright/test'

const PASSWORD = process.env.GRAVEL_ADMIN_PASSWORD ?? 'e2e-test-password'

test.describe('login + dashboard render', () => {
  test('unauthed root redirects to /login', async ({ page }) => {
    const res = await page.goto('/admin/ai/', { waitUntil: 'commit' })
    // The browser follows the redirect by default, so assert the request
    // chain shows the 302 and the final URL is /login.
    expect(res, 'response should not be null').not.toBeNull()
    const chain: number[] = []
    let r = res!.request().redirectedFrom()
    while (r) {
      const rr = await r.response()
      if (rr) chain.push(rr.status())
      r = r.redirectedFrom()
    }
    expect(chain).toContain(302)
    await expect(page).toHaveURL(/\/admin\/ai\/login$/)
  })

  test('login form 303s back to dashboard, React renders the empty prompts state', async ({
    page,
  }) => {
    await page.goto('/admin/ai/login')
    // The login HTML is the SPA shell — wait for the React-rendered form
    // (not the static HTML) before submitting.
    await page.waitForSelector('input[name="password"]', { state: 'visible' })

    // Track the POST so we can inspect status + redirect chain.
    const postPromise = page.waitForResponse(
      (resp) =>
        resp.url().endsWith('/admin/ai/api/auth/login') && resp.request().method() === 'POST',
    )
    await page.fill('input[name="password"]', PASSWORD)
    await Promise.all([page.waitForURL(/\/admin\/ai\/?$/), page.click('button[type="submit"]')])

    const postResp = await postPromise
    // Form-encoded login returns 303 See Other to mountPath. The browser
    // surfaces the *final* response (the followed GET) on resp.status();
    // dig the original status out of the redirect chain.
    const allStatuses = [postResp.status()]
    let from = postResp.request().redirectedFrom()
    while (from) {
      const r = await from.response()
      if (r) allStatuses.push(r.status())
      from = from.redirectedFrom()
    }
    expect(allStatuses).toContain(303)

    // SPA mounts into #root. Wait for the prompts list empty state copy
    // (manifest is empty in the fixture so this is the deterministic UI).
    await expect(page.locator('#root')).toBeVisible()
    await expect(page.getByText('No prompts yet')).toBeVisible({ timeout: 10_000 })
  })

  test('at least one bundled JS asset is served with the right content-type', async ({
    page,
  }) => {
    const jsResponses: { url: string; status: number; contentType: string | null }[] = []
    page.on('response', (resp) => {
      const url = resp.url()
      if (url.includes('/admin/ai/_assets/') && url.endsWith('.js')) {
        jsResponses.push({
          url,
          status: resp.status(),
          contentType: resp.headers()['content-type'] ?? null,
        })
      }
    })

    await page.goto('/admin/ai/login')
    // Give the SPA time to fetch its bundle.
    await page.waitForSelector('input[name="password"]', { state: 'visible' })

    expect(jsResponses.length, 'expected at least one /_assets/*.js response').toBeGreaterThan(0)
    for (const r of jsResponses) {
      expect(r.status, `bad status for ${r.url}`).toBe(200)
      expect(r.contentType, `missing content-type for ${r.url}`).toMatch(/javascript/)
    }
  })
})
