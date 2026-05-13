/**
 * Fastify integration.
 *
 * Usage:
 *   import Fastify from 'fastify'
 *   import { gravelFastifyPlugin } from '@artanis-ai/gravel/fastify'
 *   import { config } from './gravel.config'
 *
 *   const fastify = Fastify()
 *   fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })
 *
 * Why a dedicated adapter (vs reusing `@artanis-ai/gravel/node` like
 * Express does):
 *
 *   * Fastify's `register(plugin, { prefix })` strips the prefix from
 *     `request.url` but NOT from `request.raw.url`. The Node adapter
 *     uses `request.raw.url` (it expects an IncomingMessage), so the
 *     SDK handler would see the full prefixed URL `/admin/ai/api/...`
 *     instead of the routable suffix `/api/...` and 404 every route.
 *
 *   * This adapter builds the fetch Request from `request.url`
 *     directly, so URL prefix handling stays correct and the wizard's
 *     auto-mount can rely on Fastify's native plugin scoping.
 */
import { createGravelHandler } from '../handler/index.js'
import type { CreateHandlerOpts } from '../handler/index.js'

// Minimal structural Fastify types we lean on. Avoids taking a hard
// dep on fastify in the SDK's typecheck (users who actually call
// gravelFastifyPlugin have fastify installed in their own project, and
// the structural shapes line up with the real Fastify types).

type FastifyReply = {
  status(code: number): FastifyReply
  header(name: string, value: unknown): FastifyReply
  send(payload: unknown): unknown
}

type FastifyRequest = {
  method: string
  url: string
  hostname?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

type FastifyInstance = {
  all(
    path: string,
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ): void
}

type FastifyPluginAsync = (
  instance: FastifyInstance,
  opts: Record<string, unknown>,
) => Promise<void>

/**
 * Returns a Fastify plugin. Register it with the prefix you want the
 * dashboard mounted at — typically `config.mountPath`.
 *
 *   fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })
 */
export function gravelFastifyPlugin(opts: CreateHandlerOpts): FastifyPluginAsync {
  const handler = createGravelHandler(opts)
  const plugin: FastifyPluginAsync = async (fastify) => {
    // `/*` catches every path under the registered prefix; Fastify
    // strips the prefix before populating `request.url`, so the SDK
    // handler routes against `/api/...`, `/login`, etc. as if it
    // were mounted at the root.
    fastify.all('/*', async (request, reply) => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(request.headers)) {
        if (Array.isArray(v)) {
          for (const vv of v) headers.append(k, vv)
        } else if (v !== undefined) {
          headers.set(k, String(v))
        }
      }
      const proto =
        (request.headers['x-forwarded-proto'] as string | undefined) ?? 'http'
      const host = request.hostname ?? 'localhost'
      const url = new URL(request.url, `${proto}://${host}`)

      const init: RequestInit = {
        method: request.method,
        headers,
      }
      // Fastify already parsed the body per the route's content type.
      // GET/HEAD never carry a body; for everything else, re-serialize
      // so the SDK handler sees the same bytes the framework received.
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        request.body !== undefined &&
        request.body !== null
      ) {
        init.body =
          typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body)
      }

      const response = await handler(new Request(url, init))

      reply.status(response.status)
      response.headers.forEach((value, key) => {
        reply.header(key, value)
      })
      const buf = Buffer.from(await response.arrayBuffer())
      return reply.send(buf)
    })
  }
  return plugin
}
