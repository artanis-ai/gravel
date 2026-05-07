/**
 * Public type surface. Stable across minor versions; new optional fields ok.
 *
 * Spec: gravel-cloud/docs/spec/api-surface.md
 */

export type GravelRole = 'user' | 'admin'

export interface GravelUser {
  /** Stable per-user identifier from the host app. FK target on gravel_users. */
  id: string
  /** Shown in the dashboard chrome ("Hi Alice"). */
  firstName: string
  /** Two roles in v0/v1. */
  role: GravelRole
  /** Anything else; opaque to Gravel. Cached as `extra` on gravel_users. */
  [k: string]: unknown
}

export interface GravelRequest {
  url: string
  method: string
  headers: Headers
  cookies: { get(name: string): string | undefined }
  /** Per-framework escape hatch. */
  raw: unknown
}

export interface GravelDatabaseConfig {
  /** Postgres connection string or `file:...` for SQLite. */
  url: string
  /** Override the default `gravel_` table prefix. Don't change after first migration. */
  tablePrefix?: string
}

export interface GravelAuthConfig {
  /**
   * Pluggable callback. If set, this is the only auth path; default-password
   * mode is disabled. A null return means "redirect to host app login".
   * See gravel-cloud/docs/spec/auth.md for the contract.
   */
  getUser?: (req: GravelRequest) => Promise<GravelUser | null> | GravelUser | null
  /**
   * Default-password mode. Active only when getUser is absent. Wizard generates
   * one at install time and writes to .env as GRAVEL_ADMIN_PASSWORD.
   */
  defaultPassword?: string
}

/**
 * Config for live evals (v3). When `runPipeline` is set, the dashboard's
 * "Run live eval" button is enabled.
 */
export type RunPipelineFn = (input: unknown) => Promise<unknown> | unknown

export interface GravelEvalsConfig {
  concurrency?: { trace?: number; live?: number }
  judgeVersion?: string // 'auto' | 'v1' | 'v2' | etc.
}

export interface GravelConfig {
  /** Where the dashboard mounts inside the host app. Default '/admin/ai'. */
  mountPath?: string
  /** Product name shown in the dashboard chrome. Default 'Gravel'. */
  productName?: string
  /** Database connection. */
  database: GravelDatabaseConfig
  /** Auth. Either getUser or defaultPassword (exclusive). */
  auth: GravelAuthConfig
  /** Optional: required only for live evals. */
  runPipeline?: RunPipelineFn
  /** Optional: override the wizard-defaulted environment list. */
  environments?: string[]
  /** Optional: hide branding (Enterprise tier). */
  hideArtanisBranding?: boolean
  /** Optional: eval defaults. */
  evals?: GravelEvalsConfig
  /** Optional: PII scrubbing hooks. See spec/tracing.md §7. */
  scrubInput?: (messages: unknown) => unknown
  scrubOutput?: (text: unknown) => unknown
}

/**
 * Helper to define a config with full TypeScript inference.
 */
export function defineConfig(config: GravelConfig): GravelConfig {
  return config
}

// ---------- Default / runtime constants ----------

export const DEFAULT_MOUNT_PATH = '/admin/ai'
/**
 * Empty default — the host opts INTO branding by setting `productName`
 * in gravel.config.{ts,py}. With nothing set, the dashboard shows
 * neutral chrome (no "Gravel" header, no G logo) so the embedded
 * surface feels like part of the host app to the domain expert
 * who's logging in to review traces, not a third-party service.
 */
export const DEFAULT_PRODUCT_NAME = ''
export const DEFAULT_TABLE_PREFIX = 'gravel_'
export const DEFAULT_CONCURRENCY = { trace: 5, live: 2 } as const
export const DEFAULT_ENVIRONMENT = 'prod'

/**
 * Resolves a config object to a fully-populated runtime form with defaults.
 */
export interface ResolvedGravelConfig extends Required<Omit<GravelConfig,
  'auth' | 'runPipeline' | 'evals' | 'scrubInput' | 'scrubOutput'>> {
  auth: GravelAuthConfig
  runPipeline?: RunPipelineFn
  evals: { concurrency: { trace: number; live: number }; judgeVersion: string }
  scrubInput?: (messages: unknown) => unknown
  scrubOutput?: (text: unknown) => unknown
}

export function resolveConfig(config: GravelConfig): ResolvedGravelConfig {
  if (!config.auth.getUser && !config.auth.defaultPassword) {
    throw new Error(
      '[gravel] Auth misconfigured: provide either auth.getUser or auth.defaultPassword. ' +
        'See https://gravel.artanis.ai/docs/auth',
    )
  }
  if (config.auth.getUser && config.auth.defaultPassword) {
    // Exclusive modes (auth spec §3). Soft warn rather than hard error so a user
    // mid-migration can flip without breaking; the runtime ignores the password.
    // eslint-disable-next-line no-console
    console.warn(
      '[gravel] Both auth.getUser and auth.defaultPassword set; default password is ignored.',
    )
  }

  return {
    mountPath: config.mountPath ?? DEFAULT_MOUNT_PATH,
    productName: config.productName ?? DEFAULT_PRODUCT_NAME,
    database: {
      url: config.database.url,
      tablePrefix: config.database.tablePrefix ?? DEFAULT_TABLE_PREFIX,
    },
    auth: config.auth,
    environments: config.environments ?? [DEFAULT_ENVIRONMENT],
    hideArtanisBranding: config.hideArtanisBranding ?? false,
    evals: {
      concurrency: {
        trace: config.evals?.concurrency?.trace ?? DEFAULT_CONCURRENCY.trace,
        live: config.evals?.concurrency?.live ?? DEFAULT_CONCURRENCY.live,
      },
      judgeVersion: config.evals?.judgeVersion ?? 'auto',
    },
    runPipeline: config.runPipeline,
    scrubInput: config.scrubInput,
    scrubOutput: config.scrubOutput,
  }
}
