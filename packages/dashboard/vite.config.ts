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

export default defineConfig(({ command }) => ({
  plugins: [react()],
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
    // Proxy gravel API calls through to the running host fixture.
    // Preserves session cookies (the gravel handler issues cookies
    // scoped to the mount path; Vite forwards them transparently).
    proxy: {
      [`${MOUNT_PATH}/api`]: {
        target: `http://localhost:${HOST_PORT}`,
        changeOrigin: false,
        ws: false,
        // When the host fixture isn't running, the default Vite
        // behaviour is to return an opaque 503 — the SPA shows
        // raw "Failed to load" errors and the dev wastes 20
        // minutes thinking the SDK is broken. Surface a clear
        // JSON error instead, with the actual port we tried and
        // a hint about GRAVEL_DEV_HOST_PORT.
        configure(proxy) {
          proxy.on('error', (err, _req, res) => {
            // eslint-disable-next-line no-console
            console.error(
              `\n[gravel-dashboard] proxy → http://localhost:${HOST_PORT} failed: ${err.message}`,
            )
            // eslint-disable-next-line no-console
            console.error(
              `  Start a host fixture on port ${HOST_PORT}, or run vite with ` +
                `GRAVEL_DEV_HOST_PORT=<your-port> to point at a different one.\n`,
            )
            // `res` here is a Node ServerResponse (Vite's middleware).
            // Send a JSON 502 so fetch().then(r=>r.json()) doesn't
            // explode in the SPA, and any onError handler upstream
            // gets a clear shape to render.
            const r = res as unknown as {
              writableEnded?: boolean
              setHeader?: (k: string, v: string) => void
              statusCode?: number
              end?: (body?: string) => void
            }
            if (r.writableEnded) return
            r.setHeader?.('content-type', 'application/json')
            r.statusCode = 502
            r.end?.(
              JSON.stringify({
                error: 'gravel-host-unreachable',
                port: HOST_PORT,
                message:
                  `The Gravel host (e.g. your Next/Express app embedding the SDK) ` +
                  `isn't responding on port ${HOST_PORT}. Start it, or set ` +
                  `GRAVEL_DEV_HOST_PORT=<your-port> when running vite.`,
              }),
            )
          })
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
}))
