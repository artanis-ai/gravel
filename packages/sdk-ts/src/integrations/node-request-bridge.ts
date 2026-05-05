/**
 * Bridges Node's IncomingMessage / ServerResponse to fetch-standard Request /
 * Response. Used by Pages Router + Express integrations.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export async function incomingToFetch(req: IncomingMessage): Promise<Request> {
  const protocol = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'
  const host = req.headers.host ?? 'localhost'
  const url = new URL(req.url ?? '/', `${protocol}://${host}`)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else if (value !== undefined) {
      headers.set(key, value)
    }
  }

  const init: RequestInit = {
    method: req.method ?? 'GET',
    headers,
  }
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    if (chunks.length > 0) {
      init.body = Buffer.concat(chunks)
    }
  }

  return new Request(url, init)
}

export async function fetchToServerResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status
  for (const [key, value] of response.headers) {
    res.setHeader(key, value)
  }
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
