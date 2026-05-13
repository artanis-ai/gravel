/**
 * Dashboard SPA shell helpers.
 *
 * `rewriteShell` is the one bit of HTML manipulation the handler does:
 * Vite emits relative asset URLs (`./assets/index-XYZ.js`) so we
 * rewrite them at request time to absolute paths under the SDK mount.
 * Cheaper than serving a unique bundle per mount path, and the
 * dashboard's content-hashed filenames keep cache headers honest.
 *
 * Also injects boot-time globals the SPA reads:
 *   - __GRAVEL_MOUNT_PATH__   — API client + login form use this to
 *     build absolute URLs without re-deriving from window.location.
 *   - __GRAVEL_PRODUCT_NAME__ — re-brands the login + nav UI so the
 *     dashboard reads like part of the host product, not a Gravel
 *     sign-in screen.
 *   - __GRAVEL_HIDE_ARTANIS__ — paid-tier flag; suppresses the
 *     "Powered by Artanis" footer.
 *   - __GRAVEL_RUNTIME__      — 'typescript' here, 'python' from the
 *     Python SDK. Drives the CLI-command suggestions in dashboard
 *     copy (`npx @artanis-ai/gravel ...` vs `uvx artanis-gravel ...`)
 *     so users don't see commands referencing a binary they never
 *     installed.
 */
import type { ResolvedGravelConfig } from '../types.js'

export function rewriteShell(html: string, config: ResolvedGravelConfig): string {
  const prefix = config.mountPath.replace(/\/$/, '')
  const rewritten = html.replace(/(src|href)="\.\/assets\/([^"]+)"/g, (_, attr, file) => {
    const basename = String(file).split('/').pop() ?? file
    return `${attr}="${prefix}/_assets/${basename}"`
  })
  const globals: string[] = [
    `window.__GRAVEL_MOUNT_PATH__=${JSON.stringify(prefix)}`,
    `window.__GRAVEL_RUNTIME__="typescript"`,
  ]
  if (config.productName) {
    globals.push(`window.__GRAVEL_PRODUCT_NAME__=${JSON.stringify(config.productName)}`)
  }
  if (config.hideArtanisBranding) {
    globals.push(`window.__GRAVEL_HIDE_ARTANIS__=true`)
  }
  const inject = `<script>${globals.join(';')}</script>`
  // Inject before the SPA's <script type="module"> so the globals are
  // set before the bundle runs. Fall back to </head> if Vite ever
  // renames the entry script.
  if (rewritten.includes('<script type="module"')) {
    return rewritten.replace('<script type="module"', `${inject}\n    <script type="module"`)
  }
  return rewritten.replace('</head>', `${inject}\n  </head>`)
}
