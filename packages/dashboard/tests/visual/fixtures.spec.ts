/**
 * Visual baselines for every fixture under `tests/fixtures/sources/`.
 *
 * The visual harness (this directory's `index.html` + `main.tsx`)
 * renders `<ReviewSurface>` with the named fixture; this spec
 * iterates the fixture filenames, navigates to one per test, waits
 * for the deterministic ready sentinel, then snapshots.
 *
 * Refresh baselines after intentional renderer changes:
 *   pnpm test:visual:update
 */
import { expect, test } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sources',
)

const FIXTURES = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort()

test.describe('fixture screenshot baselines', () => {
  test('index page lists every fixture', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector(
      '[data-fixture-ready="true"][data-fixture-name="__index__"]',
      { state: 'attached' },
    )
    for (const name of FIXTURES) {
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible()
    }
  })

  for (const name of FIXTURES) {
    test(`renders ${name}`, async ({ page }) => {
      await page.goto(`/?fixture=${name}`)
      await page.waitForSelector(
        `[data-fixture-ready="true"][data-fixture-name="${name}"]`,
        { state: 'attached' },
      )
      // Make sure custom fonts are loaded so antialiasing is stable.
      await page.evaluate(() => document.fonts.ready)
      // Capture only the rendered dialog. This keeps baselines at the
      // dialog's natural rendered size (no wasted viewport background)
      // and makes the suite resolution-agnostic.
      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toHaveScreenshot(`${name}.png`, {
        maxDiffPixelRatio: 0.01,
        animations: 'disabled',
        caret: 'hide',
      })
    })
  }
})
