/**
 * `gravel login` — run the OAuth handshake and append the resulting
 * GRAVEL_PROJECT_ID + GRAVEL_API_KEY to .env.local (creating it if needed).
 *
 * This is the lazy / opt-in counterpart to `gravel init --local`: a user
 * who installed locally can later run `gravel login` to enable cloud
 * features (judge, analyze, evals) without re-running the full wizard.
 *
 * Conflict policy: if GRAVEL_PROJECT_ID / GRAVEL_API_KEY are already set in
 * the .env (via writeEnvAdditions's never-overwrite behavior), we leave them
 * alone and tell the user to clear them manually if they want to switch
 * projects.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeEnvAdditions } from '../wizard/env.js'
import { browserOAuthHandshake, resolveControlPlaneUrl } from '../wizard/oauth.js'

export interface LoginOptions {
  cwd?: string
  noBrowser?: boolean
  /** Override OAuth poll interval in ms (test injection). */
  oauthPollIntervalMs?: number
  /** Override OAuth total timeout in ms (test injection). */
  oauthTimeoutMs?: number
}

export interface LoginSummary {
  projectId: string
  apiKey: string
  envFile: string
  alreadyConfigured: boolean
  organizationName?: string
  projectName?: string
}

export async function runLogin(opts: LoginOptions = {}): Promise<LoginSummary> {
  const cwd = opts.cwd ?? process.cwd()
  const controlPlane = resolveControlPlaneUrl()

  const { envFile, hasProjectId, hasApiKey } = await detectEnv(cwd)
  if (hasProjectId && hasApiKey) {
    log(`GRAVEL_PROJECT_ID and GRAVEL_API_KEY are already set in ${envFile}.`)
    log('To switch projects, remove those two lines manually and re-run `gravel login`.')
    return {
      projectId: '',
      apiKey: '',
      envFile,
      alreadyConfigured: true,
    }
  }

  log(`Opening ${controlPlane}/cli/auth in your browser to sign in…`)
  const claim = await browserOAuthHandshake({
    baseUrl: controlPlane,
    openBrowser: !opts.noBrowser,
    ...(opts.oauthPollIntervalMs !== undefined ? { pollIntervalMs: opts.oauthPollIntervalMs } : {}),
    ...(opts.oauthTimeoutMs !== undefined ? { timeoutMs: opts.oauthTimeoutMs } : {}),
    onAuthUrl: (u) => log(`If your browser didn't open, visit: ${u}`),
  })

  await writeEnvAdditions(cwd, {
    GRAVEL_PROJECT_ID: claim.projectId,
    GRAVEL_API_KEY: claim.apiKey,
  })

  log(
    `Authorized ${claim.projectName ?? claim.projectId}` +
      (claim.organizationName ? ` (${claim.organizationName})` : ''),
  )
  log(`Wrote GRAVEL_PROJECT_ID + GRAVEL_API_KEY to ${envFile}.`)
  log('Restart your app to pick up the new env vars.')

  return {
    projectId: claim.projectId,
    apiKey: claim.apiKey,
    envFile,
    alreadyConfigured: false,
    ...(claim.projectName !== undefined ? { projectName: claim.projectName } : {}),
    ...(claim.organizationName !== undefined ? { organizationName: claim.organizationName } : {}),
  }
}

interface EnvProbe {
  envFile: string
  hasProjectId: boolean
  hasApiKey: boolean
}

async function detectEnv(cwd: string): Promise<EnvProbe> {
  // Prefer .env.local (Next convention) when it exists.
  for (const candidate of ['.env.local', '.env']) {
    const path = join(cwd, candidate)
    try {
      const contents = await fs.readFile(path, 'utf8')
      return {
        envFile: candidate,
        hasProjectId: /^GRAVEL_PROJECT_ID=/m.test(contents),
        hasApiKey: /^GRAVEL_API_KEY=/m.test(contents),
      }
    } catch {
      /* file missing — try next */
    }
  }
  return { envFile: '.env.local', hasProjectId: false, hasApiKey: false }
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg)
}
