/**
 * Next.js Pages Router integration. Adapts the standard `(req, res)`
 * signature to our fetch-style handler.
 *
 * Usage (placed by the wizard at `pages/admin/ai/[[...slug]].ts`):
 *
 *   import { createGravelHandler } from '@artanis/gravel/next-pages'
 *   import { config } from '@/gravel.config'
 *   export default createGravelHandler({ config })
 */
import { createGravelHandler as createCore } from '../handler/index.js'
import type { CreateHandlerOpts } from '../handler/index.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { incomingToFetch, fetchToServerResponse } from './node-request-bridge.js'

export function createGravelHandler(opts: CreateHandlerOpts) {
  const handler = createCore(opts)
  return async function pagesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fetchRequest = await incomingToFetch(req)
    const response = await handler(fetchRequest)
    await fetchToServerResponse(response, res)
  }
}
