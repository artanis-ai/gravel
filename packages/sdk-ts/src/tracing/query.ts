/**
 * Read-side queries for the `/api/traces*` endpoints. Mirrors what the
 * tracing auto-patches write via `persist.ts`, joined with observations
 * + feedback so the dashboard can render trace lists/detail pages.
 *
 * Both Postgres and SQLite are supported. The shapes returned match
 * `packages/dashboard/src/lib/types.ts :: TraceListItem /
 * TraceDetailResponse` exactly — don't drift one without the other.
 */
import { and, desc, eq, gte, inArray, like, lte, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { Database } from '../db/index.js'

export interface TraceFilters {
  env?: string
  model?: string
  status?: 'running' | 'completed' | 'errored'
  q?: string
  from?: string // ISO
  to?: string // ISO
  page?: number
  pageSize?: number
}

export interface TraceListItem {
  id: string
  name: string
  model: string | null
  environment: string | null
  status: string
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  feedback_count: number
  feedback_score: 'positive' | 'negative' | 'mixed' | null
}

export interface TracesPage {
  traces: TraceListItem[]
  total: number
  page: number
  page_size: number
}

const DEFAULT_PAGE_SIZE = 20

function isoOrNull(d: Date | number | string | null | undefined): string | null {
  if (d == null) return null
  if (d instanceof Date) return d.toISOString()
  if (typeof d === 'number') return new Date(d).toISOString()
  return new Date(d).toISOString()
}

function clampPageSize(n: number | undefined): number {
  if (!n || n < 1) return DEFAULT_PAGE_SIZE
  return Math.min(n, 100)
}

/**
 * Aggregate feedback into a single signal per trace:
 *   all positive → 'positive', all negative → 'negative',
 *   mixed → 'mixed', empty → null.
 */
function rollUpFeedback(scores: (string | null)[]): TraceListItem['feedback_score'] {
  const valid = scores.filter((s): s is 'positive' | 'negative' | 'neutral' => Boolean(s))
  if (valid.length === 0) return null
  const hasPos = valid.includes('positive')
  const hasNeg = valid.includes('negative')
  if (hasPos && hasNeg) return 'mixed'
  if (hasPos) return 'positive'
  if (hasNeg) return 'negative'
  return null
}

export async function listTraces(db: Database, filters: TraceFilters): Promise<TracesPage> {
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = clampPageSize(filters.pageSize)
  const offset = (page - 1) * pageSize

  if (db.dialect === 'postgres') {
    const { gravelTraces, gravelEnvironments, gravelObservations, gravelFeedback } =
      await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase

    const conds = [] as ReturnType<typeof eq>[]
    if (filters.env) {
      conds.push(eq(gravelEnvironments.name, filters.env))
    }
    if (filters.status) conds.push(eq(gravelTraces.status, filters.status))
    if (filters.from) conds.push(gte(gravelTraces.timestamp, new Date(filters.from)))
    if (filters.to) conds.push(lte(gravelTraces.timestamp, new Date(filters.to)))
    if (filters.q) conds.push(like(gravelTraces.name, `%${filters.q}%`))

    const whereClause = conds.length > 0 ? and(...conds) : undefined

    const [{ count } = { count: 0 }] = (await drz
      .select({ count: sql<number>`count(*)::int` })
      .from(gravelTraces)
      .leftJoin(gravelEnvironments, eq(gravelTraces.environmentId, gravelEnvironments.id))
      .where(whereClause)) as Array<{ count: number }>

    const rows = await drz
      .select({
        id: gravelTraces.id,
        name: gravelTraces.name,
        environment: gravelEnvironments.name,
        status: gravelTraces.status,
        startedAt: gravelTraces.startedAt,
        completedAt: gravelTraces.completedAt,
        durationMs: gravelTraces.durationMs,
        metadata: gravelTraces.metadata,
      })
      .from(gravelTraces)
      .leftJoin(gravelEnvironments, eq(gravelTraces.environmentId, gravelEnvironments.id))
      .where(whereClause)
      .orderBy(desc(gravelTraces.timestamp))
      .limit(pageSize)
      .offset(offset)

    if (rows.length === 0) {
      return { traces: [], total: count, page, page_size: pageSize }
    }

    const ids = rows.map((r) => r.id)
    // Token counts come from observations whose data has `usage`.
    const obsRows = await drz
      .select({
        traceId: gravelObservations.traceId,
        data: gravelObservations.data,
        type: gravelObservations.type,
      })
      .from(gravelObservations)
      .where(sql`${gravelObservations.traceId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
    const tokensByTrace = new Map<string, { in: number; out: number; model: string | null }>()
    for (const o of obsRows) {
      const data = (o.data ?? {}) as { usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }; model?: string }
      if (data.usage) {
        const cur = tokensByTrace.get(o.traceId) ?? { in: 0, out: 0, model: null }
        cur.in += data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0
        cur.out += data.usage.completion_tokens ?? data.usage.output_tokens ?? 0
        if (data.model && !cur.model) cur.model = data.model
        tokensByTrace.set(o.traceId, cur)
      } else if (data.model) {
        const cur = tokensByTrace.get(o.traceId) ?? { in: 0, out: 0, model: null }
        if (!cur.model) cur.model = data.model
        tokensByTrace.set(o.traceId, cur)
      }
    }

    const fbRows = await drz
      .select({
        traceId: gravelFeedback.traceId,
        score: gravelFeedback.score,
      })
      .from(gravelFeedback)
      .where(sql`${gravelFeedback.traceId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
    const fbByTrace = new Map<string, string[]>()
    for (const f of fbRows) {
      if (!f.traceId) continue
      const list = fbByTrace.get(f.traceId) ?? []
      list.push(f.score ?? '')
      fbByTrace.set(f.traceId, list)
    }

    const traces: TraceListItem[] = rows.map((r) => {
      const tk = tokensByTrace.get(r.id)
      const fb = fbByTrace.get(r.id) ?? []
      return {
        id: r.id,
        name: r.name,
        model: tk?.model ?? null,
        environment: r.environment,
        status: r.status,
        started_at: isoOrNull(r.startedAt) ?? new Date(0).toISOString(),
        completed_at: isoOrNull(r.completedAt),
        duration_ms: r.durationMs,
        tokens_in: tk?.in ?? null,
        tokens_out: tk?.out ?? null,
        feedback_count: fb.length,
        feedback_score: rollUpFeedback(fb),
      }
    })

    const filtered = filters.model
      ? traces.filter((t) => t.model === filters.model)
      : traces
    return { traces: filtered, total: count, page, page_size: pageSize }
  }

  // SQLite path
  const { gravelTraces, gravelEnvironments, gravelObservations, gravelFeedback } =
    await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database

  const conds = [] as ReturnType<typeof eq>[]
  if (filters.env) conds.push(eq(gravelEnvironments.name, filters.env))
  if (filters.status) conds.push(eq(gravelTraces.status, filters.status))
  if (filters.from) conds.push(gte(gravelTraces.timestamp, new Date(filters.from).getTime()))
  if (filters.to) conds.push(lte(gravelTraces.timestamp, new Date(filters.to).getTime()))
  if (filters.q) conds.push(like(gravelTraces.name, `%${filters.q}%`))
  const whereClause = conds.length > 0 ? and(...conds) : undefined

  const totalRows = drz
    .select({ count: sql<number>`count(*)` })
    .from(gravelTraces)
    .leftJoin(gravelEnvironments, eq(gravelTraces.environmentId, gravelEnvironments.id))
    .where(whereClause)
    .all() as Array<{ count: number }>
  const total = totalRows[0]?.count ?? 0

  const rows = drz
    .select({
      id: gravelTraces.id,
      name: gravelTraces.name,
      environment: gravelEnvironments.name,
      status: gravelTraces.status,
      startedAt: gravelTraces.startedAt,
      completedAt: gravelTraces.completedAt,
      durationMs: gravelTraces.durationMs,
    })
    .from(gravelTraces)
    .leftJoin(gravelEnvironments, eq(gravelTraces.environmentId, gravelEnvironments.id))
    .where(whereClause)
    .orderBy(desc(gravelTraces.timestamp))
    .limit(pageSize)
    .offset(offset)
    .all()

  if (rows.length === 0) {
    return { traces: [], total, page, page_size: pageSize }
  }

  const ids = rows.map((r) => r.id)
  const obsRowsRaw = drz
    .select({ traceId: gravelObservations.traceId, data: gravelObservations.data })
    .from(gravelObservations)
    .where(inArray(gravelObservations.traceId, ids))
    .all() as Array<{ traceId: string; data: string }>
  const tokensByTrace = new Map<string, { in: number; out: number; model: string | null }>()
  for (const o of obsRowsRaw) {
    let data: { usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }; model?: string } = {}
    try {
      data = typeof o.data === 'string' ? JSON.parse(o.data) : (o.data as never)
    } catch {
      /* ignore malformed */
    }
    if (data.usage || data.model) {
      const cur = tokensByTrace.get(o.traceId) ?? { in: 0, out: 0, model: null }
      cur.in += data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0
      cur.out += data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0
      if (data.model && !cur.model) cur.model = data.model
      tokensByTrace.set(o.traceId, cur)
    }
  }

  const fbRows = drz
    .select({ traceId: gravelFeedback.traceId, score: gravelFeedback.score })
    .from(gravelFeedback)
    .where(inArray(gravelFeedback.traceId, ids))
    .all()
  const fbByTrace = new Map<string, string[]>()
  for (const f of fbRows) {
    if (!f.traceId) continue
    const list = fbByTrace.get(f.traceId) ?? []
    list.push(f.score ?? '')
    fbByTrace.set(f.traceId, list)
  }

  const traces: TraceListItem[] = rows.map((r) => {
    const tk = tokensByTrace.get(r.id)
    const fb = fbByTrace.get(r.id) ?? []
    return {
      id: r.id,
      name: r.name,
      model: tk?.model ?? null,
      environment: r.environment,
      status: r.status,
      started_at: isoOrNull(r.startedAt) ?? new Date(0).toISOString(),
      completed_at: isoOrNull(r.completedAt),
      duration_ms: r.durationMs,
      tokens_in: tk?.in ?? null,
      tokens_out: tk?.out ?? null,
      feedback_count: fb.length,
      feedback_score: rollUpFeedback(fb),
    }
  })

  const filtered = filters.model ? traces.filter((t) => t.model === filters.model) : traces
  return { traces: filtered, total, page, page_size: pageSize }
}

export interface TraceDetail {
  trace: TraceListItem & {
    commit_sha: string | null
    metadata: Record<string, unknown> | null
  }
  observations: Array<{
    id: string
    trace_id: string
    type: string
    name: string | null
    key: string | null
    data: unknown
    timestamp: string
  }>
  feedback: Array<{
    id: string
    trace_id: string | null
    observation_id: string | null
    comment: string | null
    correction: string | null
    score: string | null
    reporter_user_id: string | null
    created_at: string
  }>
}

export async function getTraceDetail(db: Database, traceId: string): Promise<TraceDetail | null> {
  const list = await listTraces(db, { page: 1, pageSize: 100 })
  const row = list.traces.find((t) => t.id === traceId)
  // listTraces returns up to pageSize; if traceId isn't there, look it up
  // directly. This double-path is fine for v0; refactor when traffic warrants.
  let listItem = row ?? null
  if (!listItem) {
    // Fallback: query the trace directly.
    const direct = await listTracesById(db, traceId)
    if (!direct) return null
    listItem = direct
  }

  if (db.dialect === 'postgres') {
    const { gravelTraces, gravelObservations, gravelFeedback } = await import(
      '../schema/postgres.js'
    )
    const drz = db.drizzle as NodePgDatabase
    const traceRows = await drz
      .select({
        commitSha: gravelTraces.commitSha,
        metadata: gravelTraces.metadata,
      })
      .from(gravelTraces)
      .where(eq(gravelTraces.id, traceId))
      .limit(1)
    const traceMeta = traceRows[0]
    const observations = (await drz
      .select({
        id: gravelObservations.id,
        traceId: gravelObservations.traceId,
        type: gravelObservations.type,
        key: gravelObservations.key,
        data: gravelObservations.data,
        timestamp: gravelObservations.timestamp,
      })
      .from(gravelObservations)
      .where(eq(gravelObservations.traceId, traceId))
      .orderBy(gravelObservations.timestamp)) as Array<{
      id: string
      traceId: string
      type: string
      key: string | null
      data: unknown
      timestamp: Date
    }>
    const feedback = await drz
      .select({
        id: gravelFeedback.id,
        traceId: gravelFeedback.traceId,
        observationId: gravelFeedback.observationId,
        comment: gravelFeedback.comment,
        correction: gravelFeedback.correction,
        score: gravelFeedback.score,
        reporterUserId: gravelFeedback.reporterUserId,
        createdAt: gravelFeedback.createdAt,
      })
      .from(gravelFeedback)
      .where(eq(gravelFeedback.traceId, traceId))
      .orderBy(desc(gravelFeedback.createdAt))
    return {
      trace: {
        ...listItem,
        commit_sha: traceMeta?.commitSha ?? null,
        metadata: (traceMeta?.metadata as Record<string, unknown> | null) ?? null,
      },
      observations: observations.map((o) => ({
        id: o.id,
        trace_id: o.traceId,
        type: o.type,
        name: o.key ?? null,
        key: o.key,
        data: o.data,
        timestamp: isoOrNull(o.timestamp) ?? new Date(0).toISOString(),
      })),
      feedback: feedback.map((f) => ({
        id: f.id,
        trace_id: f.traceId,
        observation_id: f.observationId,
        comment: f.comment,
        correction: f.correction,
        score: f.score,
        reporter_user_id: f.reporterUserId,
        created_at: isoOrNull(f.createdAt) ?? new Date(0).toISOString(),
      })),
    }
  }

  // SQLite
  const { gravelTraces, gravelObservations, gravelFeedback } = await import(
    '../schema/sqlite.js'
  )
  const drz = db.drizzle as BetterSQLite3Database
  const traceRows = drz
    .select({ commitSha: gravelTraces.commitSha, metadata: gravelTraces.metadata })
    .from(gravelTraces)
    .where(eq(gravelTraces.id, traceId))
    .limit(1)
    .all() as Array<{ commitSha: string | null; metadata: string | null }>
  const traceMeta = traceRows[0]
  const observations = drz
    .select({
      id: gravelObservations.id,
      traceId: gravelObservations.traceId,
      type: gravelObservations.type,
      key: gravelObservations.key,
      data: gravelObservations.data,
      timestamp: gravelObservations.timestamp,
    })
    .from(gravelObservations)
    .where(eq(gravelObservations.traceId, traceId))
    .orderBy(gravelObservations.timestamp)
    .all() as Array<{
    id: string
    traceId: string
    type: string
    key: string | null
    data: string
    timestamp: number
  }>
  const feedback = drz
    .select({
      id: gravelFeedback.id,
      traceId: gravelFeedback.traceId,
      observationId: gravelFeedback.observationId,
      comment: gravelFeedback.comment,
      correction: gravelFeedback.correction,
      score: gravelFeedback.score,
      reporterUserId: gravelFeedback.reporterUserId,
      createdAt: gravelFeedback.createdAt,
    })
    .from(gravelFeedback)
    .where(eq(gravelFeedback.traceId, traceId))
    .orderBy(desc(gravelFeedback.createdAt))
    .all() as Array<{
    id: string
    traceId: string | null
    observationId: string | null
    comment: string | null
    correction: string | null
    score: string | null
    reporterUserId: string | null
    createdAt: number
  }>
  let parsedMeta: Record<string, unknown> | null = null
  if (traceMeta?.metadata) {
    try {
      parsedMeta = JSON.parse(traceMeta.metadata) as Record<string, unknown>
    } catch {
      /* ignore */
    }
  }
  return {
    trace: {
      ...listItem,
      commit_sha: traceMeta?.commitSha ?? null,
      metadata: parsedMeta,
    },
    observations: observations.map((o) => {
      let data: unknown = o.data
      try {
        data = typeof o.data === 'string' ? JSON.parse(o.data) : o.data
      } catch {
        /* ignore */
      }
      return {
        id: o.id,
        trace_id: o.traceId,
        type: o.type,
        name: o.key ?? null,
        key: o.key,
        data,
        timestamp: isoOrNull(o.timestamp) ?? new Date(0).toISOString(),
      }
    }),
    feedback: feedback.map((f) => ({
      id: f.id,
      trace_id: f.traceId,
      observation_id: f.observationId,
      comment: f.comment,
      correction: f.correction,
      score: f.score,
      reporter_user_id: f.reporterUserId,
      created_at: isoOrNull(f.createdAt) ?? new Date(0).toISOString(),
    })),
  }
}

/** Look up a single trace by id when it falls outside the first list page. */
async function listTracesById(db: Database, traceId: string): Promise<TraceListItem | null> {
  if (db.dialect === 'postgres') {
    const { gravelTraces, gravelEnvironments, gravelObservations, gravelFeedback } =
      await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const rows = await drz
      .select({
        id: gravelTraces.id,
        name: gravelTraces.name,
        environment: gravelEnvironments.name,
        status: gravelTraces.status,
        startedAt: gravelTraces.startedAt,
        completedAt: gravelTraces.completedAt,
        durationMs: gravelTraces.durationMs,
      })
      .from(gravelTraces)
      .leftJoin(gravelEnvironments, eq(gravelTraces.environmentId, gravelEnvironments.id))
      .where(eq(gravelTraces.id, traceId))
      .limit(1)
    const r = rows[0]
    if (!r) return null
    const obs = await drz
      .select({ data: gravelObservations.data })
      .from(gravelObservations)
      .where(eq(gravelObservations.traceId, traceId))
    let tIn = 0,
      tOut = 0,
      model: string | null = null
    for (const o of obs) {
      const d = (o.data ?? {}) as { usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }; model?: string }
      if (d.usage) {
        tIn += d.usage.prompt_tokens ?? d.usage.input_tokens ?? 0
        tOut += d.usage.completion_tokens ?? d.usage.output_tokens ?? 0
      }
      if (d.model && !model) model = d.model
    }
    const fb = await drz
      .select({ score: gravelFeedback.score })
      .from(gravelFeedback)
      .where(eq(gravelFeedback.traceId, traceId))
    return {
      id: r.id,
      name: r.name,
      model,
      environment: r.environment,
      status: r.status,
      started_at: isoOrNull(r.startedAt) ?? new Date(0).toISOString(),
      completed_at: isoOrNull(r.completedAt),
      duration_ms: r.durationMs,
      tokens_in: tIn || null,
      tokens_out: tOut || null,
      feedback_count: fb.length,
      feedback_score: rollUpFeedback(fb.map((f) => f.score)),
    }
  }
  // SQLite
  const { gravelTraces, gravelEnvironments, gravelObservations, gravelFeedback } =
    await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const rows = drz
    .select({
      id: gravelTraces.id,
      name: gravelTraces.name,
      environment: gravelEnvironments.name,
      status: gravelTraces.status,
      startedAt: gravelTraces.startedAt,
      completedAt: gravelTraces.completedAt,
      durationMs: gravelTraces.durationMs,
    })
    .from(gravelTraces)
    .leftJoin(gravelEnvironments, eq(gravelTraces.environmentId, gravelEnvironments.id))
    .where(eq(gravelTraces.id, traceId))
    .limit(1)
    .all()
  const r = rows[0]
  if (!r) return null
  const obs = drz
    .select({ data: gravelObservations.data })
    .from(gravelObservations)
    .where(eq(gravelObservations.traceId, traceId))
    .all() as Array<{ data: string }>
  let tIn = 0,
    tOut = 0,
    model: string | null = null
  for (const o of obs) {
    let d: { usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }; model?: string } = {}
    try {
      d = typeof o.data === 'string' ? JSON.parse(o.data) : (o.data as never)
    } catch {
      /* */
    }
    if (d.usage) {
      tIn += d.usage.prompt_tokens ?? d.usage.input_tokens ?? 0
      tOut += d.usage.completion_tokens ?? d.usage.output_tokens ?? 0
    }
    if (d.model && !model) model = d.model
  }
  const fb = drz
    .select({ score: gravelFeedback.score })
    .from(gravelFeedback)
    .where(eq(gravelFeedback.traceId, traceId))
    .all() as Array<{ score: string | null }>
  return {
    id: r.id,
    name: r.name,
    model,
    environment: r.environment,
    status: r.status,
    started_at: isoOrNull(r.startedAt) ?? new Date(0).toISOString(),
    completed_at: isoOrNull(r.completedAt),
    duration_ms: r.durationMs,
    tokens_in: tIn || null,
    tokens_out: tOut || null,
    feedback_count: fb.length,
    feedback_score: rollUpFeedback(fb.map((f) => f.score)),
  }
}

/** Insert a feedback row. Used by `POST /api/traces/:id/feedback`. */
export async function recordTraceFeedback(
  db: Database,
  args: {
    traceId: string
    score?: 'positive' | 'negative' | 'neutral' | null
    comment?: string | null
    correction?: string | null
    reporterUserId: string
  },
): Promise<{ id: string }> {
  const id = `f_${cryptoRandomHex(12)}`
  const now = new Date()
  if (db.dialect === 'postgres') {
    const { gravelFeedback } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    await drz.insert(gravelFeedback).values({
      id,
      traceId: args.traceId,
      score: args.score ?? null,
      comment: args.comment ?? null,
      correction: args.correction ?? null,
      reporterUserId: args.reporterUserId,
      timestamp: now,
    })
  } else {
    const { gravelFeedback } = await import('../schema/sqlite.js')
    const drz = db.drizzle as BetterSQLite3Database
    drz
      .insert(gravelFeedback)
      .values({
        id,
        traceId: args.traceId,
        score: args.score ?? null,
        comment: args.comment ?? null,
        correction: args.correction ?? null,
        reporterUserId: args.reporterUserId,
        timestamp: now.getTime(),
      })
      .run()
  }
  return { id }
}

function cryptoRandomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2))
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len)
}
