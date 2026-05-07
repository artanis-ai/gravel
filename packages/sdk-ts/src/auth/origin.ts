/**
 * Localhost detection for the request's *browser-facing* hostname.
 *
 * Used by the auth gate to skip login on developer machines (localhost
 * = admin pattern). The signal is the browser's view of the URL — not
 * the server's local interface — because in production behind a
 * reverse proxy the server sees Host: 127.0.0.1 even when the public
 * hostname is something else entirely. We prefer X-Forwarded-Host (set
 * by trustworthy proxies like nginx / Caddy / Vercel) and fall back to
 * Host.
 *
 * Trust model: a malicious actor who can spoof X-Forwarded-Host has
 * already breached the reverse proxy boundary, at which point the
 * dashboard's auth boundary is the least of the operator's problems.
 * Common reverse-proxy configs strip incoming X-Forwarded-* headers
 * and rewrite them, so the default behaviour is safe.
 *
 * Operators who run everything on the public internet without a proxy
 * (rare for a dashboard mount) can disable the heuristic by setting
 * `localhostIsAdmin: false` in gravel.config.{ts,py}.
 */
import type { GravelRequest } from '../types.js'

const LITERAL_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

/**
 * Returns the hostname the browser thinks it's talking to. Strips port
 * and IPv6 brackets. `null` when no host header is present (rare —
 * HTTP/1.1 requires it, but defensive against pathological clients).
 */
export function browserFacingHostname(req: GravelRequest): string | null {
  const xfh = req.headers.get('x-forwarded-host')
  const host = req.headers.get('host')
  // X-Forwarded-Host can be a comma-separated list when there's a chain
  // of proxies — the leftmost is the original client-facing hostname.
  const first = (xfh ?? host ?? '').split(',')[0]?.trim() ?? ''
  if (!first) return null
  return stripPortAndBrackets(first).toLowerCase()
}

/**
 * Pull the hostname out of a Host-header value, handling IPv6 brackets
 * (e.g. `[::1]:3000` → `::1`, plain `::1` → `::1`) and IPv4-with-port
 * (`127.0.0.1:8080` → `127.0.0.1`). Bare IPv6 with no brackets *and*
 * no port (`::1`) is left alone — the colons are part of the address.
 */
function stripPortAndBrackets(input: string): string {
  if (input.startsWith('[')) {
    const close = input.indexOf(']')
    return close === -1 ? input.slice(1) : input.slice(1, close)
  }
  // Treat as host:port only when there's exactly one colon (so an IPv6
  // literal isn't mangled). For IPv4 / DNS hosts the colon count is
  // always 0 or 1.
  const colons = (input.match(/:/g) ?? []).length
  if (colons === 1) {
    const idx = input.lastIndexOf(':')
    return input.slice(0, idx)
  }
  return input
}

export function isLocalhostRequest(req: GravelRequest): boolean {
  const hostname = browserFacingHostname(req)
  if (!hostname) return false
  if (LITERAL_LOCAL_HOSTS.has(hostname)) return true
  // RFC 6761: `*.localhost` is reserved as loopback.
  if (hostname.endsWith('.localhost')) return true
  // Whole 127.0.0.0/8 block is loopback.
  if (/^127(\.\d{1,3}){3}$/.test(hostname)) return true
  return false
}
