/**
 * Internal "write a trace + observations" helper used by the auto-patches.
 *
 * Spec: gravel-cloud/docs/spec/tracing.md §3, §6
 *
 * Design notes:
 *   - Provider patches do NOT block the user's call on this. We `void` the
 *     persist call from the patch site and swallow errors here so a broken DB
 *     never breaks user code (spec §6: "Failures don't block the LLM call").
 *   - The DB connection is opened lazily on first persist using the resolved
 *     config that `createGravelHandler` plumbs in via `setGravelTracingConfig`.
 *     If the user wires `import '@artanis-ai/gravel/auto'` but never spins up
 *     the handler, we have no DB to write to — we log once and no-op.
 *   - Environments are a FK; we lazy-upsert the named environment on first
 *     write so traces never fail because the env row is missing.
 *   - We follow the schema in src/schema/{postgres,sqlite}.ts exactly.
 *     Observation `type` is one of 'input' | 'output' | 'state' (not
 *     llm/function/span — see schema + spec §3).
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { ResolvedGravelConfig } from '../types.js'
import { openDatabase, type Database } from '../db/index.js'
import { gravelContext } from './context.js'

export interface PersistTraceInput {
  /** Logical name, e.g. "openai.chat.completions.create". */
  name: string
  status: 'completed' | 'errored'
  startedAt: Date
  finishedAt: Date
  /** Provider-normalized fields surfaced into trace metadata for cross-provider analytics. */
  model?: string
  provider?: 'openai' | 'anthropic' | 'langchain' | 'vercel-ai' | string
  tokensInput?: number
  tokensOutput?: number
  /** Captured request payload (messages, params). Stored on input observation. */
  input: unknown
  /** Captured response (content, tool_calls, finish_reason, etc.). Stored on output observation. */
  output?: unknown
  /** Optional: state observations (streaming chunk summary, intermediate steps). */
  states?: Array<{ key?: string; data: unknown }>
  /** Set when status === 'errored'. Stored on a state observation with key 'error'. */
  errorMessage?: string
}

let resolvedConfig: ResolvedGravelConfig | null = null
let cachedDb: Database | null = null
let dbOpenPromise: Promise<Database | null> | null = null
let warnedNoConfig = false
let warnedDbFailure = false

/**
 * Wired by `createGravelHandler` so the tracer has a DB to write into.
 * Safe to call multiple times — last config wins.
 */
export function setGravelTracingConfig(config: ResolvedGravelConfig): void {
  resolvedConfig = config
  // Reset the cached DB so the next persist re-opens against the new config.
  cachedDb = null
  dbOpenPromise = null
}

/** Test seam — restore module to pristine state between tests. */
export function _resetGravelTracingForTests(): void {
  resolvedConfig = null
  cachedDb = null
  dbOpenPromise = null
  warnedNoConfig = false
  warnedDbFailure = false
}

async function getDb(): Promise<Database | null> {
  if (cachedDb) return cachedDb
  if (!resolvedConfig) {
    if (!warnedNoConfig) {
      warnedNoConfig = true
      // eslint-disable-next-line no-console
      console.warn(
        '[gravel] tracing: no DB configured yet — call createGravelHandler() before LLM calls fire, or ignore this if you only want manual tracing.',
      )
    }
    return null
  }
  if (!dbOpenPromise) {
    const cfg = resolvedConfig
    dbOpenPromise = openDatabase(cfg.database)
      .then((db) => {
        cachedDb = db
        return db
      })
      .catch((err) => {
        if (!warnedDbFailure) {
          warnedDbFailure = true
          // eslint-disable-next-line no-console
          console.warn('[gravel] tracing: failed to open DB —', (err as Error).message)
        }
        dbOpenPromise = null
        return null
      })
  }
  return await dbOpenPromise
}

function getEnvironmentName(): string {
  const fromEnv = process.env.GRAVEL_ENVIRONMENT
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return resolvedConfig?.environments?.[0] ?? 'prod'
}

// (gravel_environments was dropped 2026-05-08; environment is now a
// free-form text column on gravel_traces.)

/**
 * Persist a single sample (one LLM call). Never throws — tracer
 * failures must not break the user's LLM call. Called from provider
 * patches as `void persistSample(...)` so the user's call returns
 * before this completes.
 */
export async function persistSample(payload: PersistTraceInput): Promise<void> {
  try {
    if (gravelContext.isTracingDisabled()) return
    const db = await getDb()
    if (!db) return

    const environment = getEnvironmentName()

    // Apply user-provided scrubbers (spec §7) before write.
    const scrubInput = resolvedConfig?.scrubInput
    const scrubOutput = resolvedConfig?.scrubOutput
    const inputData = scrubInput ? scrubInput(payload.input) : payload.input
    const outputData =
      scrubOutput && payload.output !== undefined ? scrubOutput(payload.output) : payload.output

    const sampleId = randomUUID()
    const durationMs = Math.max(0, payload.finishedAt.getTime() - payload.startedAt.getTime())

    // Merge async-context metadata (spec §4) with normalized provider
    // fields. Agent intermediate states + error message land here too —
    // there's no separate observations table any more (D-Q53 2026-05-08).
    const metadata: Record<string, unknown> = { ...gravelContext.getMetadata() }
    if (payload.provider) metadata.provider = payload.provider
    if (payload.tokensInput !== undefined) metadata.tokens_input = payload.tokensInput
    if (payload.tokensOutput !== undefined) metadata.tokens_output = payload.tokensOutput
    if (payload.states && payload.states.length > 0) {
      metadata.states = payload.states.map((s) => ({ key: s.key, data: s.data ?? null }))
    }
    if (payload.errorMessage) metadata.error = payload.errorMessage

    const status = payload.status === 'errored' ? 'errored' : 'completed'

    if (db.dialect === 'postgres') {
      const { gravelSamples } = await import('../schema/postgres.js')
      const drz = db.drizzle as import('drizzle-orm/node-postgres').NodePgDatabase
      await drz.insert(gravelSamples).values({
        id: sampleId,
        name: payload.name,
        environment,
        model: payload.model ?? null,
        status,
        input: (inputData ?? null) as object,
        output: (outputData ?? null) as object,
        metadata,
        timestamp: payload.startedAt,
        startedAt: payload.startedAt,
        completedAt: payload.finishedAt,
        durationMs,
      })
    } else {
      const { gravelSamples } = await import('../schema/sqlite.js')
      const drz = db.drizzle as import('drizzle-orm/better-sqlite3').BetterSQLite3Database
      drz
        .insert(gravelSamples)
        .values({
          id: sampleId,
          name: payload.name,
          environment,
          model: payload.model ?? null,
          status,
          input: JSON.stringify(inputData ?? null),
          output: JSON.stringify(outputData ?? null),
          metadata: JSON.stringify(metadata),
          timestamp: payload.startedAt.getTime(),
          startedAt: payload.startedAt.getTime(),
          completedAt: payload.finishedAt.getTime(),
          durationMs,
        })
        .run()
    }
  } catch (err) {
    // Spec §6: tracer failures must never bubble. Log once so it's debuggable.
    if (!warnedDbFailure) {
      warnedDbFailure = true
      // eslint-disable-next-line no-console
      console.warn('[gravel] tracing: persist failed —', (err as Error).message)
    }
  }
}
