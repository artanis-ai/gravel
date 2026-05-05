/**
 * Generic Node integration (Express, Fastify-with-adapter, vanilla http).
 *
 * Usage:
 *   import express from 'express'
 *   import { gravelHandler } from '@artanis/gravel/node'
 *   import { config } from './gravel.config.js'
 *
 *   const app = express()
 *   app.use(config.mountPath ?? '/admin/ai', gravelHandler({ config }))
 */
import { createGravelHandler } from '../handler/index.js'
import type { CreateHandlerOpts } from '../handler/index.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { incomingToFetch, fetchToServerResponse } from './node-request-bridge.js'

export function gravelHandler(opts: CreateHandlerOpts) {
  const handler = createGravelHandler(opts)
  return async function (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void): Promise<void> {
    try {
      const fetchRequest = await incomingToFetch(req)
      const response = await handler(fetchRequest)
      await fetchToServerResponse(response, res)
    } catch (err) {
      if (next) next(err)
      else {
        res.statusCode = 500
        res.end(String(err))
      }
    }
  }
}
