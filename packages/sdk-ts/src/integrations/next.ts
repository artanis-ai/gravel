/**
 * Next.js App Router integration.
 *
 * Usage (placed by the wizard at `app/admin/ai/[[...slug]]/route.ts`):
 *
 *   import { createGravelHandler } from '@artanis/gravel/next'
 *   import { config } from '@/gravel.config'
 *
 *   const handler = createGravelHandler({ config })
 *   export const GET = handler
 *   export const POST = handler
 *   export const PUT = handler
 *   export const DELETE = handler
 */
import { createGravelHandler as createCore } from '../handler/index.js'
import type { CreateHandlerOpts } from '../handler/index.js'

export function createGravelHandler(opts: CreateHandlerOpts) {
  const handler = createCore(opts)
  // Next App Router passes a Request; we already speak that.
  return async function nextHandler(request: Request): Promise<Response> {
    return await handler(request)
  }
}
