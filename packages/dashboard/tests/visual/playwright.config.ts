/**
 * Playwright config for the visual fixture test suite. Separate from
 * the dashboard's main `playwright.config.ts` (which exercises auth /
 * samples / prompts / github flows through the real SDK middleware).
 *
 * The webServer here is a minimal Vite app rooted at this directory,
 * NOT the dashboard SPA — see `vite.config.ts`. That keeps the test
 * harness fully outside the dashboard's `src/` so neither the prod
 * SPA build nor the SDK's `_dashboard_dist/` ever bundles it.
 *
 * Baselines live under `tests/visual/fixtures.spec.ts-snapshots/`,
 * committed to the repo so CI catches renderer drift on every PR.
 *
 * To refresh after an intentional renderer change:
 *   pnpm test:visual:update
 */
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.VISUAL_PORT ?? 5400)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `pnpm exec vite --config ${import.meta.dirname}/vite.config.ts`,
    url: BASE_URL,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
})
