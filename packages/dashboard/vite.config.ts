/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { gravelDevHandler } from './src/dev/in-process-handler.js'

/**
 * Two build targets share this config:
 *
 *   1. `vite build` / `pnpm build` — bundles the SPA into `dist/`,
 *      which the SDK then base64-embeds into its handler at tsup-build
 *      time. The host's Next/Express/etc. serves these files via the
 *      `_assets/<id>` route. `base: './'` keeps asset URLs relative so
 *      the SDK can rewrite them under any `mountPath`.
 *
 *   2. `vite` / `pnpm dev` — standalone HMR dev server on :5173. The
 *      `gravelDevHandler` plugin mounts the SDK handler in-process
 *      via Vite middleware, so every `/admin/ai/api/*` request hits
 *      real SDK code without a separate Next/Express fixture
 *      running. Full HMR for the SPA, zero infra to start. Set
 *      `GRAVEL_DEV_DATABASE_URL=file:./gravel.dev.db` to enable
 *      traces; default is prompts-only.
 */
const MOUNT_PATH = process.env.GRAVEL_DEV_MOUNT_PATH ?? '/admin/ai'

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    // Only mount the in-process handler during `vite` / `vite serve`.
    // For production builds the handler comes from the host app.
    ...(command === 'serve' ? [gravelDevHandler({ mountPath: MOUNT_PATH })] : []),
  ],
  // Build: relative URLs so the SDK can rewrite assets under any mount
  // path at request time. Dev: serve under MOUNT_PATH so assets resolve
  // correctly when the gravel handler redirects to ${mountPath}/ after
  // login (otherwise the post-login page lands on /admin/ai/ but Vite
  // can only find the SPA bundle relative to the wrong base, and the
  // user sees a blank page).
  base: command === 'serve' ? `${MOUNT_PATH}/` : './',
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
    // No proxy — the gravelDevHandler plugin (above) mounts the SDK
    // handler in-process so Vite serves the dashboard SPA AND the
    // /api/* routes from the same Node process.
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
}))
