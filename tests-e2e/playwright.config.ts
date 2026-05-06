import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the Gravel E2E smoke.
 *
 * One project (Chromium, headless). The webServer runs the bundled
 * test-app — a tiny Hono server that mounts `createGravelHandler` from
 * the workspace-linked SDK. SQLite + default-password mode keeps the
 * fixture self-contained.
 */
const PORT = Number(process.env.E2E_PORT ?? 4321)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  // Smoke suite — keep it fast and serial so log output is easy to follow
  // when something goes wrong.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm --filter ./test-app dev',
    url: `${BASE_URL}/admin/ai/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      E2E_PORT: String(PORT),
      GRAVEL_ADMIN_PASSWORD: process.env.GRAVEL_ADMIN_PASSWORD ?? 'e2e-test-password',
      DATABASE_URL: process.env.DATABASE_URL ?? 'file:./test.db',
    },
  },
})
