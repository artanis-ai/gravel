/**
 * Vite middleware that mounts the SDK handler in-process. No proxy,
 * no separate Next/Express fixture, no port juggling. The dashboard
 * SPA gets full Vite HMR; every `/admin/ai/api/*` request is served
 * by the same `createGravelHandler` code Next would call in
 * production.
 *
 * The SDK handler speaks fetch — `(Request) => Promise<Response>`.
 * Vite middleware speaks Connect — `(req, res, next) => void`. This
 * file bridges the two. Handles GET/POST/etc, request bodies,
 * response streaming, and the cookie / set-cookie back-and-forth.
 *
 * Config defaults to prompts-only with a hardcoded dev password
 * (`dev`). Set `GRAVEL_DEV_DATABASE_URL` to enable traces; the
 * handler will bootstrap a SQLite file at that path.
 */
import type { Connect, Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createGravelHandler } from '@artanis-ai/gravel'
import type { GravelConfig } from '@artanis-ai/gravel'

const DEV_PASSWORD = process.env.GRAVEL_DEV_PASSWORD ?? 'dev'

export interface InProcessHandlerOptions {
  mountPath?: string
}

export function gravelDevHandler(opts: InProcessHandlerOptions = {}): Plugin {
  const mountPath = opts.mountPath ?? '/admin/ai'
  const apiPrefix = `${mountPath}/api`

  // Build a minimal config the moment Vite boots its dev server. No
  // gravel.config.ts on disk — this is purely the dashboard's own
  // dev experience. The SPA's API client uses the same mount path
  // via `window.__GRAVEL_MOUNT_PATH__`.
  const config: GravelConfig = {
    mountPath,
    auth: { defaultPassword: DEV_PASSWORD },
    // localhostIsAdmin defaults to true, so the dev who's running
    // Vite locally lands as admin without typing the password.
  }
  if (process.env.GRAVEL_DEV_DATABASE_URL) {
    config.database = { url: process.env.GRAVEL_DEV_DATABASE_URL }
  }

  const handler = createGravelHandler({ config })

  return {
    name: 'gravel-dev-handler',
    configureServer(server) {
      // eslint-disable-next-line no-console
      console.log(
        `\n[gravel-dev] in-process handler mounted at ${mountPath}/api/* ` +
          `(password: ${DEV_PASSWORD}${config.database ? `, db: ${config.database.url}` : ', no DB'})\n`,
      )

      const middleware: Connect.NextHandleFunction = async (req, res, next) => {
        const url = req.url ?? '/'
        // Only intercept API calls. Asset / SPA / non-API routes
        // continue down Vite's normal middleware chain.
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
            res.end(JSON.stringify({ error: 'gravel-dev-handler-threw', message: (err as Error).message }))
          }
        }
      }
      server.middlewares.use(middleware)
    },
  }
}

/**
 * Convert Node's IncomingMessage to a Web `Request`. We reconstruct
 * the URL from the Host header, copy headers verbatim, and buffer
 * the body for non-GET/HEAD methods. Buffering is fine for our use
 * case — API requests are small (login form, JSON payloads). No
 * streaming needed.
 */
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
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readBody(req)
  }

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

/**
 * Write a Web `Response` to a Node `ServerResponse`. Multiple
 * Set-Cookie headers (the spec allows them) are forwarded as a
 * comma-joined header — Web Headers stores them as a single comma-
 * joined value, which is what every browser expects.
 */
async function writeWebResponseToNodeRes(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    // Skip content-encoding (we don't re-compress here) and
    // transfer-encoding (Node sets it itself based on the body).
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
