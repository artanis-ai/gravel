/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Two build targets share this config:
 *
 *   1. `vite build` / `pnpm build` — bundles the SPA into `dist/`,
 *      which the SDK then base64-embeds into its handler at tsup-build
 *      time. The host's Next/Express/etc. serves these files via the
 *      `_assets/<id>` route. `base: './'` keeps asset URLs relative so
 *      the SDK can rewrite them under any `mountPath`.
 *
 *   2. `vite` / `pnpm dev` — standalone HMR dev server on :5173 for
 *      iterating on the dashboard UI. API calls + the mount-path
 *      window global are proxied/stubbed so the SPA talks to a real
 *      gravel handler running in a host fixture (default port 3000)
 *      without a full SDK + Next rebuild loop. Override the host port
 *      via `GRAVEL_DEV_HOST_PORT=3001`. See packages/dashboard/README
 *      for the full workflow.
 */
const HOST_PORT = process.env.GRAVEL_DEV_HOST_PORT ?? '3000'
const MOUNT_PATH = process.env.GRAVEL_DEV_MOUNT_PATH ?? '/admin/ai'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  // Inject the same window globals the SDK's `rewriteShell` injects in
  // production. The SPA's API client + login form read these at boot.
  define: {
    'window.__GRAVEL_MOUNT_PATH__': JSON.stringify(MOUNT_PATH),
  },
  server: {
    port: 5173,
    // Proxy gravel API calls through to the running host fixture.
    // Preserves session cookies (the gravel handler issues cookies
    // scoped to the mount path; Vite forwards them transparently).
    proxy: {
      [`${MOUNT_PATH}/api`]: {
        target: `http://localhost:${HOST_PORT}`,
        changeOrigin: false,
        ws: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
