/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite'
import type { Connect } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
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
 *   2. `vite` / `pnpm dev` — standalone HMR dev server on :5173. The
 *      `gravelDevHandler` plugin mounts the SDK handler in-process
 *      via Vite middleware, so every `/admin/ai/api/*` request hits
 *      real SDK code without a separate Next/Express fixture
 *      running. Full HMR for the SPA, zero infra to start. Set
 *      `GRAVEL_DEV_DATABASE_URL=file:./gravel.dev.db` to enable
 *      traces; default is prompts-only. Set
 *      `GRAVEL_REPO_ROOT=/path/to/your/app` to read prompts from a
 *      real repo (default: this package's cwd, which is empty).
 */
const MOUNT_PATH = process.env.GRAVEL_DEV_MOUNT_PATH ?? '/admin/ai'
const DEV_PASSWORD = process.env.GRAVEL_DEV_PASSWORD ?? 'dev'

/**
 * Hide the `@artanis-ai/gravel` import target from esbuild's static
 * analysis. esbuild bundles vite.config.ts (for `vite build`,
 * `vitest`, etc.) and traces every literal-string `import()` it sees
 * — even dynamic ones inside `configureServer` hooks that won't
 * actually run during a build. The `Function`-built importer hides
 * the path from that scan; runtime behaviour is identical.
 */
const importAtRuntime = new Function('p', 'return import(p)') as <T = unknown>(
  p: string,
) => Promise<T>

function gravelDevHandler(): Plugin {
  return {
    name: 'gravel-dev-handler',
    async configureServer(server) {
      type SdkModule = typeof import('@artanis-ai/gravel')
      let sdk: SdkModule
      try {
        sdk = await importAtRuntime<SdkModule>('@artanis-ai/gravel')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `\n[gravel-dev] couldn't import @artanis-ai/gravel: ${(err as Error).message}\n` +
            `  Build the SDK first:\n` +
            `    pnpm --filter @artanis-ai/gravel build\n`,
        )
        return
      }

      const config: import('@artanis-ai/gravel').GravelConfig = {
        mountPath: MOUNT_PATH,
        auth: { defaultPassword: DEV_PASSWORD },
        // localhostIsAdmin defaults to true, so the dev who's running
        // Vite locally lands as admin without typing the password.
      }
      if (process.env.GRAVEL_DEV_DATABASE_URL) {
        config.database = { url: process.env.GRAVEL_DEV_DATABASE_URL }
      }

      const handler = sdk.createGravelHandler({ config })

      const repoRoot = process.env.GRAVEL_REPO_ROOT ?? process.cwd()
      // eslint-disable-next-line no-console
      console.log(
        `\n[gravel-dev] in-process handler mounted at ${MOUNT_PATH}/api/* ` +
          `(password: ${DEV_PASSWORD}${config.database ? `, db: ${config.database.url}` : ', no DB'})\n` +
          `[gravel-dev] reading manifest + prompt files from: ${repoRoot}\n` +
          (process.env.GRAVEL_REPO_ROOT
            ? ''
            : `[gravel-dev] (set GRAVEL_REPO_ROOT=/path/to/your/app to point at a real repo)\n`),
      )

      const apiPrefix = `${MOUNT_PATH}/api`
      const middleware: Connect.NextHandleFunction = async (req, res, next) => {
        const url = req.url ?? '/'
        if (!url.startsWith(apiPrefix)) return next()
        try {
          const request = await nodeReqToWebRequest(req)
          const response = await handler(request)
          await writeWebResponseToNodeRes(response, res)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[gravel-dev] handler threw:', err)
          if (!res.writableEnded) {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(
              JSON.stringify({
                error: 'gravel-dev-handler-threw',
                message: (err as Error).message,
              }),
            )
          }
        }
      }
      server.middlewares.use(middleware)
    },
  }
}

async function nodeReqToWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? 'localhost'
  const protocol = (req.socket as unknown as { encrypted?: boolean }).encrypted ? 'https' : 'http'
  const url = new URL(req.url ?? '/', `${protocol}://${host}`)
  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const item of v) headers.append(k, item)
    else if (typeof v === 'string') headers.set(k, v)
  }
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') body = await readBody(req)
  return new Request(url.toString(), {
    method,
    headers,
    body: body && body.length > 0 ? new Uint8Array(body) : undefined,
  })
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function writeWebResponseToNodeRes(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    if (key === 'content-encoding' || key === 'transfer-encoding') return
    res.setHeader(key, value)
  })
  if (response.body) {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
  }
  res.end()
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    // Only mount the in-process handler during `vite` / `vite serve`.
    // For production builds the handler comes from the host app.
    ...(command === 'serve' ? [gravelDevHandler()] : []),
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
    // Off the default 5173 so we don't collide with Console's vite or
    // the other workspace vite instances (Multiland uses 5273+).
    // strictPort: refuse to drift if 5300 is taken — better to fail
    // loudly than start somewhere unexpected and surprise the browser.
    port: 5300,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
}))
