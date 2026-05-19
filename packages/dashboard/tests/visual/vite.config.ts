/**
 * Vite config for the visual fixture test harness. Test-only — not
 * used for production dashboard builds. Roots at `tests/visual/` so
 * its entry HTML / main.tsx live alongside the fixture JSON they
 * render.
 *
 * Inherits the dashboard's Tailwind + PostCSS setup automatically:
 * PostCSS resolves config from the nearest parent
 * `postcss.config.cjs`, which is the dashboard root.
 */
/// <reference types="vite/client" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  // Read PostCSS / Tailwind config from the dashboard package root
  // (one level up from tests/) so the same classes the SPA uses are
  // emitted here too.
  css: { postcss: resolve(here, '..', '..') },
  plugins: [react()],
  server: {
    port: Number(process.env.VISUAL_PORT ?? 5400),
    strictPort: true,
  },
})
