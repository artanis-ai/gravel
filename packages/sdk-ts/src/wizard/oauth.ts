/**
 * Browser-OAuth handshake against `gravel.artanis.ai`.
 *
 * Flow (control plane is live — endpoints listed in gravel-cloud/docs/spec/api-surface.md):
 *   1. Generate a 32-char random token.
 *   2. Pick a free localhost port (try preferred range, fall back to ephemeral).
 *   3. Spin up a tiny HTTP server on that port (heartbeat / "you can close this" page).
 *   4. POST {token, redirect_port} to /api/cli/auth/init.
 *   5. Open the user's browser to /cli/auth?token=<token>.
 *   6. Poll /api/cli/auth/claim?token=<token> every 1.5 s for up to 10 minutes.
 *   7. On 200, return creds. On 404/410, throw a clear error.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const DEFAULT_CONTROL_PLANE = 'https://gravel.artanis.ai'
const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 10 * 60 * 1000
const TOKEN_BYTES = 24 // 24 bytes -> 32 base64url chars (no padding)
const PREFERRED_PORTS = [42424, 42425, 42426, 42427, 42428]

export interface OAuthClaim {
  projectId: string
  apiKey: string
  organizationName?: string
  projectName?: string
}

export interface OAuthHandshakeOptions {
  /** Override the control-plane base URL (also reads GRAVEL_CONTROL_PLANE_URL env). */
  baseUrl?: string
  /** Skip launching the user's browser (useful for tests / CI). */
  openBrowser?: boolean
  /** Override the polling interval (ms). */
  pollIntervalMs?: number
  /** Override the total polling timeout (ms). */
  timeoutMs?: number
  /** Optional callback invoked once the browser-handoff URL is known. */
  onAuthUrl?: (url: string) => void
}

export function resolveControlPlaneUrl(override?: string): string {
  return override ?? process.env.GRAVEL_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE
}

/** Crypto-strong base64url-ish 32-char token. */
export function generateAuthToken(): string {
  return randomBytes(TOKEN_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 32)
}

interface ListenResult {
  server: Server
  port: number
}

async function listenOnce(port: number): Promise<ListenResult> {
  return await new Promise<ListenResult>((resolve, reject) => {
    const server = createServer((req, res) => {
      // Heartbeat / friendly close page. The browser hand-off lands on the
      // hosted /cli/auth page, not here — but if the user pastes the redirect
      // URL or curls the port, give them something readable.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Gravel CLI</title>' +
          '<body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">' +
          '<h1>Gravel CLI</h1>' +
          '<p>You can close this tab and return to your terminal.</p>' +
          '</body>',
      )
      void req // unused
    })
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const addr = server.address()
      const actual = typeof addr === 'object' && addr ? addr.port : port
      resolve({ server, port: actual })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/** Try preferred ports, fall back to an ephemeral port. */
export async function pickFreePort(preferred: number[] = PREFERRED_PORTS): Promise<ListenResult> {
  for (const p of preferred) {
    try {
      return await listenOnce(p)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err
    }
  }
  return await listenOnce(0)
}

function openBrowserUrl(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: platform() === 'win32' })
    child.on('error', () => {
      /* swallow — best-effort. The auth URL is also printed for the user. */
    })
    child.unref()
  } catch {
    /* swallow — the URL is also logged by the wizard. */
  }
}

interface InitResponse {
  ok: true
  expires_in_seconds: number
}

interface ClaimResponseSuccess {
  project_id: string
  api_key: string
  project_name?: string
  organization_name?: string
}

async function postInit(baseUrl: string, token: string, redirectPort: number): Promise<InitResponse> {
  const res = await fetch(`${baseUrl}/api/cli/auth/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, redirect_port: redirectPort }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[gravel] auth/init failed: ${res.status} ${res.statusText} ${text}`.trim())
  }
  return (await res.json()) as InitResponse
}

type PollOutcome =
  | { kind: 'claimed'; data: ClaimResponseSuccess }
  | { kind: 'pending' }
  | { kind: 'expired' }
  | { kind: 'not_found' }

async function pollClaim(baseUrl: string, token: string): Promise<PollOutcome> {
  const res = await fetch(`${baseUrl}/api/cli/auth/claim?token=${encodeURIComponent(token)}`)
  if (res.status === 200) {
    return { kind: 'claimed', data: (await res.json()) as ClaimResponseSuccess }
  }
  if (res.status === 202) return { kind: 'pending' }
  if (res.status === 410) return { kind: 'expired' }
  if (res.status === 404) return { kind: 'not_found' }
  const text = await res.text().catch(() => '')
  throw new Error(`[gravel] auth/claim unexpected ${res.status}: ${text}`.trim())
}

export async function browserOAuthHandshake(opts: OAuthHandshakeOptions = {}): Promise<OAuthClaim> {
  const baseUrl = resolveControlPlaneUrl(opts.baseUrl)
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS

  const token = generateAuthToken()
  const { server, port } = await pickFreePort()

  try {
    await postInit(baseUrl, token, port)

    const authUrl = `${baseUrl}/cli/auth?token=${encodeURIComponent(token)}`
    if (opts.onAuthUrl) opts.onAuthUrl(authUrl)
    if (opts.openBrowser !== false) openBrowserUrl(authUrl)

    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const outcome = await pollClaim(baseUrl, token)
      if (outcome.kind === 'claimed') {
        const d = outcome.data
        return {
          projectId: d.project_id,
          apiKey: d.api_key,
          ...(d.project_name !== undefined ? { projectName: d.project_name } : {}),
          ...(d.organization_name !== undefined ? { organizationName: d.organization_name } : {}),
        }
      }
      if (outcome.kind === 'expired') {
        throw new Error('[gravel] Auth token expired before the browser flow completed (10 min). Re-run `gravel init`.')
      }
      if (outcome.kind === 'not_found') {
        throw new Error('[gravel] Auth token was not recognised by the control plane. Re-run `gravel init`.')
      }
      // pending — wait then retry
      await delay(pollIntervalMs)
    }
    throw new Error('[gravel] Timed out waiting for browser sign-in (10 min). Re-run `gravel init`.')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
