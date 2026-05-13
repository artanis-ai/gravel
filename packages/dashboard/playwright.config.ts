/**
 * Playwright config for the dashboard E2E suite.
 *
 * Each test runs against the Vite dev server (`pnpm dev`), which
 * mounts the real SDK handler in-process via the Vite middleware in
 * `vite.config.ts`. That means E2E tests exercise the same code path
 * a customer would hit — login, samples, prompts, github — without
 * a separate Next/Express fixture.
 *
 * Why standalone Vite vs. spinning up a fixture: the SDK route table
 * is identical regardless of the host framework (proven by the
 * Python `test_embedded_journey.py` cross-stack equality test). The
 * dashboard's UI doesn't care which adapter served the JSON. The
 * variance is in the adapters, which have their own integration
 * coverage in `tests/handler-*.test.ts`.
 */
import { defineConfig, devices } from '@playwright/test'

// Vite dev server picks 5300 in this repo's config (vite.config.ts).
// Override with E2E_PORT for parallel runs / port collisions.
const PORT = Number(process.env.E2E_PORT ?? 5300)
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // SDK state (cookies, DB) is process-global
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    // The dev server only responds at the mount path; probing the root
    // bare-domain returns 404. Point Playwright's readiness probe at
    // a known-200 URL.
    url: `${BASE_URL}/admin/ai/api/auth/me`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      // Loopback host => auto-admin shortcut; no login required for
      // the dashboard routes.
      GRAVEL_DEV_PASSWORD: 'e2e-pw',
    },
  },
})
