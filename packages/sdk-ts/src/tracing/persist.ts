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
const ensuredEnvironments = new Map<string, string>()

/**
 * Wired by `createGravelHandler` so the tracer has a DB to write into.
 * Safe to call multiple times — last config wins.
 */
export function setGravelTracingConfig(config: ResolvedGravelConfig): void {
  resolvedConfig = config
  // Reset the cached DB so the next persist re-opens against the new config.
  cachedDb = null
  dbOpenPromise = null
  ensuredEnvironments.clear()
}

/** Test seam — restore module to pristine state between tests. */
export function _resetGravelTracingForTests(): void {
  resolvedConfig = null
  cachedDb = null
  dbOpenPromise = null
  warnedNoConfig = false
  warnedDbFailure = false
  ensuredEnvironments.clear()
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

async function ensureEnvironment(db: Database, name: string): Promise<string> {
  const existing = ensuredEnvironments.get(name)
  if (existing) return existing
  // Lazy-import schema variant matching the dialect.
  if (db.dialect === 'postgres') {
    const { gravelEnvironments } = await import('../schema/postgres.js')
    const drz = db.drizzle as import('drizzle-orm/node-postgres').NodePgDatabase
    const found = await drz
      .select({ id: gravelEnvironments.id })
      .from(gravelEnvironments)
      .where(eq(gravelEnvironments.name, name))
      .limit(1)
    if (found.length > 0 && found[0]) {
      ensuredEnvironments.set(name, found[0].id)
      return found[0].id
    }
    const inserted = await drz
      .insert(gravelEnvironments)
      .values({ name })
      .onConflictDoNothing({ target: gravelEnvironments.name })
      .returning({ id: gravelEnvironments.id })
    if (inserted.length > 0 && inserted[0]) {
      ensuredEnvironments.set(name, inserted[0].id)
      return inserted[0].id
    }
    // Race: another writer inserted; re-select.
    const refound = await drz
      .select({ id: gravelEnvironments.id })
      .from(gravelEnvironments)
      .where(eq(gravelEnvironments.name, name))
      .limit(1)
    if (refound.length > 0 && refound[0]) {
      ensuredEnvironments.set(name, refound[0].id)
      return refound[0].id
    }
    throw new Error(`[gravel] failed to ensure environment row for "${name}"`)
  } else {
    const { gravelEnvironments } = await import('../schema/sqlite.js')
    const drz = db.drizzle as import('drizzle-orm/better-sqlite3').BetterSQLite3Database
    const found = drz
      .select({ id: gravelEnvironments.id })
      .from(gravelEnvironments)
      .where(eq(gravelEnvironments.name, name))
      .limit(1)
      .all()
    if (found.length > 0 && found[0]) {
      ensuredEnvironments.set(name, found[0].id)
      return found[0].id
    }
    const id = randomUUID()
    drz
      .insert(gravelEnvironments)
      .values({ id, name })
      .onConflictDoNothing({ target: gravelEnvironments.name })
      .run()
    const refound = drz
      .select({ id: gravelEnvironments.id })
      .from(gravelEnvironments)
      .where(eq(gravelEnvironments.name, name))
      .limit(1)
      .all()
    if (refound.length > 0 && refound[0]) {
      ensuredEnvironments.set(name, refound[0].id)
      return refound[0].id
    }
    throw new Error(`[gravel] failed to ensure environment row for "${name}"`)
  }
}

/**
 * Persist a single trace + its observations. Never throws — tracer failures
 * must not break the user's LLM call. Called from provider patches as
 * `void persistTrace(...)` so the user's call returns before this completes.
 */
export async function persistTrace(payload: PersistTraceInput): Promise<void> {
  try {
    if (gravelContext.isTracingDisabled()) return
    const db = await getDb()
    if (!db) return

    const envName = getEnvironmentName()
    const environmentId = await ensureEnvironment(db, envName)

    // Apply user-provided scrubbers (spec §7) before write.
    const scrubInput = resolvedConfig?.scrubInput
    const scrubOutput = resolvedConfig?.scrubOutput
    const inputData = scrubInput ? scrubInput(payload.input) : payload.input
    const outputData =
      scrubOutput && payload.output !== undefined ? scrubOutput(payload.output) : payload.output

    const traceId = randomUUID()
    const durationMs = Math.max(0, payload.finishedAt.getTime() - payload.startedAt.getTime())

    // Merge async-context metadata (spec §4) with normalized provider fields.
    const baseMetadata: Record<string, unknown> = { ...gravelContext.getMetadata() }
    if (payload.provider) baseMetadata.provider = payload.provider
    if (payload.model) baseMetadata.model = payload.model
    if (payload.tokensInput !== undefined) baseMetadata.tokens_input = payload.tokensInput
    if (payload.tokensOutput !== undefined) baseMetadata.tokens_output = payload.tokensOutput

    if (db.dialect === 'postgres') {
      const { gravelTraces, gravelObservations } = await import('../schema/postgres.js')
      const drz = db.drizzle as import('drizzle-orm/node-postgres').NodePgDatabase
      await drz.insert(gravelTraces).values({
        id: traceId,
        name: payload.name,
        environmentId,
        metadata: baseMetadata,
        status: payload.status === 'errored' ? 'errored' : 'completed',
        timestamp: payload.startedAt,
        startedAt: payload.startedAt,
        completedAt: payload.finishedAt,
        durationMs,
      })
      const obsRows: Array<typeof gravelObservations.$inferInsert> = [
        {
          id: randomUUID(),
          traceId,
          type: 'input',
          data: inputData as object,
          timestamp: payload.startedAt,
        },
      ]
      if (outputData !== undefined) {
        obsRows.push({
          id: randomUUID(),
          traceId,
          type: 'output',
          data: (outputData ?? null) as object,
          timestamp: payload.finishedAt,
        })
      }
      for (const s of payload.states ?? []) {
        obsRows.push({
          id: randomUUID(),
          traceId,
          type: 'state',
          key: s.key,
          data: (s.data ?? null) as object,
          timestamp: payload.finishedAt,
        })
      }
      if (payload.errorMessage) {
        obsRows.push({
          id: randomUUID(),
          traceId,
          type: 'state',
          key: 'error',
          data: { message: payload.errorMessage } as object,
          timestamp: payload.finishedAt,
        })
      }
      await drz.insert(gravelObservations).values(obsRows)
    } else {
      const { gravelTraces, gravelObservations } = await import('../schema/sqlite.js')
      const drz = db.drizzle as import('drizzle-orm/better-sqlite3').BetterSQLite3Database
      drz
        .insert(gravelTraces)
        .values({
          id: traceId,
          name: payload.name,
          environmentId,
          metadata: JSON.stringify(baseMetadata),
          status: payload.status === 'errored' ? 'errored' : 'completed',
          timestamp: payload.startedAt.getTime(),
          startedAt: payload.startedAt.getTime(),
          completedAt: payload.finishedAt.getTime(),
          durationMs,
        })
        .run()
      const obsRows: Array<typeof gravelObservations.$inferInsert> = [
        {
          id: randomUUID(),
          traceId,
          type: 'input',
          data: JSON.stringify(inputData ?? null),
          timestamp: payload.startedAt.getTime(),
        },
      ]
      if (outputData !== undefined) {
        obsRows.push({
          id: randomUUID(),
          traceId,
          type: 'output',
          data: JSON.stringify(outputData ?? null),
          timestamp: payload.finishedAt.getTime(),
        })
      }
      for (const s of payload.states ?? []) {
        obsRows.push({
          id: randomUUID(),
          traceId,
          type: 'state',
          key: s.key,
          data: JSON.stringify(s.data ?? null),
          timestamp: payload.finishedAt.getTime(),
        })
      }
      if (payload.errorMessage) {
        obsRows.push({
          id: randomUUID(),
          traceId,
          type: 'state',
          key: 'error',
          data: JSON.stringify({ message: payload.errorMessage }),
          timestamp: payload.finishedAt.getTime(),
        })
      }
      drz.insert(gravelObservations).values(obsRows).run()
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
