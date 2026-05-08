/**
 * Read-side queries for `/api/samples*`. Mirrors what the tracing
 * auto-patches write via `tracing/persist.ts :: persistSample`,
 * joined with feedback so the dashboard can render the Outputs list
 * + sample detail sheet.
 *
 * Shape returned matches `packages/dashboard/src/lib/types.ts ::
 * SampleListItem / SampleDetailResponse` exactly. Don't drift one
 * without the other.
 */
import { and, desc, eq, gte, inArray, like, lte, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { Database } from '../db/index.js'

export interface SampleFilters {
  env?: string
  model?: string
  status?: 'running' | 'completed' | 'errored'
  q?: string
  from?: string
  to?: string
  page?: number
  pageSize?: number
}

export interface SampleListItem {
  id: string
  name: string
  model: string | null
  environment: string | null
  status: string
  group_id: string | null
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  feedback_count: number
  feedback_score: 'positive' | 'negative' | 'mixed' | null
}

export interface SamplesPage {
  samples: SampleListItem[]
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

function rollUpFeedback(scores: (string | null)[]): SampleListItem['feedback_score'] {
  const valid = scores.filter((s): s is 'positive' | 'negative' | 'neutral' => Boolean(s))
  if (valid.length === 0) return null
  const hasPos = valid.includes('positive')
  const hasNeg = valid.includes('negative')
  if (hasPos && hasNeg) return 'mixed'
  if (hasPos) return 'positive'
  if (hasNeg) return 'negative'
  return null
}

function tokensFromMetadata(meta: unknown): { in: number | null; out: number | null } {
  if (!meta) return { in: null, out: null }
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta)
    } catch {
      return { in: null, out: null }
    }
  }
  if (typeof meta !== 'object' || meta === null) return { in: null, out: null }
  const m = meta as { tokens_input?: number; tokens_output?: number }
  return {
    in: typeof m.tokens_input === 'number' ? m.tokens_input : null,
    out: typeof m.tokens_output === 'number' ? m.tokens_output : null,
  }
}

export async function listSamples(db: Database, filters: SampleFilters): Promise<SamplesPage> {
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = clampPageSize(filters.pageSize)
  const offset = (page - 1) * pageSize

  if (db.dialect === 'postgres') {
    const { gravelSamples, gravelFeedback } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase

    const conds = [] as ReturnType<typeof eq>[]
    if (filters.env) conds.push(eq(gravelSamples.environment, filters.env))
    if (filters.model) conds.push(eq(gravelSamples.model, filters.model))
    if (filters.status) conds.push(eq(gravelSamples.status, filters.status))
    if (filters.from) conds.push(gte(gravelSamples.timestamp, new Date(filters.from)))
    if (filters.to) conds.push(lte(gravelSamples.timestamp, new Date(filters.to)))
    if (filters.q) conds.push(like(gravelSamples.name, `%${filters.q}%`))

    const whereClause = conds.length > 0 ? and(...conds) : undefined

    const [{ count } = { count: 0 }] = (await drz
      .select({ count: sql<number>`count(*)::int` })
      .from(gravelSamples)
      .where(whereClause)) as Array<{ count: number }>

    const rows = await drz
      .select({
        id: gravelSamples.id,
        name: gravelSamples.name,
        groupId: gravelSamples.groupId,
        environment: gravelSamples.environment,
        model: gravelSamples.model,
        status: gravelSamples.status,
        startedAt: gravelSamples.startedAt,
        completedAt: gravelSamples.completedAt,
        durationMs: gravelSamples.durationMs,
        metadata: gravelSamples.metadata,
      })
      .from(gravelSamples)
      .where(whereClause)
      .orderBy(desc(gravelSamples.timestamp))
      .limit(pageSize)
      .offset(offset)

    if (rows.length === 0) {
      return { samples: [], total: count, page, page_size: pageSize }
    }

    const ids = rows.map((r) => r.id)
    const fbRows = await drz
      .select({ sampleId: gravelFeedback.sampleId, score: gravelFeedback.score })
      .from(gravelFeedback)
      .where(inArray(gravelFeedback.sampleId, ids))
    const fbBySample = new Map<string, string[]>()
    for (const f of fbRows) {
      const list = fbBySample.get(f.sampleId) ?? []
      list.push(f.score ?? '')
      fbBySample.set(f.sampleId, list)
    }

    const samples: SampleListItem[] = rows.map((r) => {
      const tk = tokensFromMetadata(r.metadata)
      const fb = fbBySample.get(r.id) ?? []
      return {
        id: r.id,
        name: r.name,
        model: r.model,
        environment: r.environment,
        status: r.status,
        group_id: r.groupId,
        started_at: isoOrNull(r.startedAt) ?? new Date(0).toISOString(),
        completed_at: isoOrNull(r.completedAt),
        duration_ms: r.durationMs,
        tokens_in: tk.in,
        tokens_out: tk.out,
        feedback_count: fb.length,
        feedback_score: rollUpFeedback(fb),
      }
    })
    return { samples, total: count, page, page_size: pageSize }
  }

  // SQLite
  const { gravelSamples, gravelFeedback } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database

  const conds = [] as ReturnType<typeof eq>[]
  if (filters.env) conds.push(eq(gravelSamples.environment, filters.env))
  if (filters.model) conds.push(eq(gravelSamples.model, filters.model))
  if (filters.status) conds.push(eq(gravelSamples.status, filters.status))
  if (filters.from) conds.push(gte(gravelSamples.timestamp, new Date(filters.from).getTime()))
  if (filters.to) conds.push(lte(gravelSamples.timestamp, new Date(filters.to).getTime()))
  if (filters.q) conds.push(like(gravelSamples.name, `%${filters.q}%`))
  const whereClause = conds.length > 0 ? and(...conds) : undefined

  const totalRows = drz
    .select({ count: sql<number>`count(*)` })
    .from(gravelSamples)
    .where(whereClause)
    .all() as Array<{ count: number }>
  const total = totalRows[0]?.count ?? 0

  const rows = drz
    .select({
      id: gravelSamples.id,
      name: gravelSamples.name,
      groupId: gravelSamples.groupId,
      environment: gravelSamples.environment,
      model: gravelSamples.model,
      status: gravelSamples.status,
      startedAt: gravelSamples.startedAt,
      completedAt: gravelSamples.completedAt,
      durationMs: gravelSamples.durationMs,
      metadata: gravelSamples.metadata,
    })
    .from(gravelSamples)
    .where(whereClause)
    .orderBy(desc(gravelSamples.timestamp))
    .limit(pageSize)
    .offset(offset)
    .all()

  if (rows.length === 0) {
    return { samples: [], total, page, page_size: pageSize }
  }

  const ids = rows.map((r) => r.id)
  const fbRows = drz
    .select({ sampleId: gravelFeedback.sampleId, score: gravelFeedback.score })
    .from(gravelFeedback)
    .where(inArray(gravelFeedback.sampleId, ids))
    .all()
  const fbBySample = new Map<string, string[]>()
  for (const f of fbRows) {
    const list = fbBySample.get(f.sampleId) ?? []
    list.push(f.score ?? '')
    fbBySample.set(f.sampleId, list)
  }

  const samples: SampleListItem[] = rows.map((r) => {
    const tk = tokensFromMetadata(r.metadata)
    const fb = fbBySample.get(r.id) ?? []
    return {
      id: r.id,
      name: r.name,
      model: r.model,
      environment: r.environment,
      status: r.status,
      group_id: r.groupId,
      started_at: isoOrNull(r.startedAt) ?? new Date(0).toISOString(),
      completed_at: isoOrNull(r.completedAt),
      duration_ms: r.durationMs,
      tokens_in: tk.in,
      tokens_out: tk.out,
      feedback_count: fb.length,
      feedback_score: rollUpFeedback(fb),
    }
  })
  return { samples, total, page, page_size: pageSize }
}

export interface SampleDetail {
  sample: SampleListItem & {
    commit_sha: string | null
    input: unknown
    output: unknown
    metadata: Record<string, unknown> | null
  }
  feedback: Array<{
    id: string
    sample_id: string
    comment: string | null
    correction: string | null
    score: string | null
    reporter_user_id: string | null
    created_at: string
  }>
  /** Other samples sharing this sample's group_id (a "trace"). */
  related: SampleListItem[]
}

function parseJson(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export async function getSampleDetail(db: Database, sampleId: string): Promise<SampleDetail | null> {
  // Use the list path to get the basic shape, then add input/output/metadata.
  const list = await listSamples(db, { page: 1, pageSize: 100 })
  let summary = list.samples.find((s) => s.id === sampleId) ?? null
  if (!summary) {
    const direct = await listSampleById(db, sampleId)
    if (!direct) return null
    summary = direct
  }

  if (db.dialect === 'postgres') {
    const { gravelSamples, gravelFeedback } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const detailRows = await drz
      .select({
        commitSha: gravelSamples.commitSha,
        input: gravelSamples.input,
        output: gravelSamples.output,
        metadata: gravelSamples.metadata,
      })
      .from(gravelSamples)
      .where(eq(gravelSamples.id, sampleId))
      .limit(1)
    const det = detailRows[0]

    const feedback = await drz
      .select({
        id: gravelFeedback.id,
        sampleId: gravelFeedback.sampleId,
        comment: gravelFeedback.comment,
        correction: gravelFeedback.correction,
        score: gravelFeedback.score,
        reporterUserId: gravelFeedback.reporterUserId,
        createdAt: gravelFeedback.createdAt,
      })
      .from(gravelFeedback)
      .where(eq(gravelFeedback.sampleId, sampleId))
      .orderBy(desc(gravelFeedback.createdAt))

    const related = summary.group_id
      ? (
          await drz
            .select({ id: gravelSamples.id })
            .from(gravelSamples)
            .where(eq(gravelSamples.groupId, summary.group_id))
        ).map((r) => r.id)
      : []
    const relatedFull: SampleListItem[] = []
    for (const id of related) {
      if (id === sampleId) continue
      const item = list.samples.find((s) => s.id === id) ?? (await listSampleById(db, id))
      if (item) relatedFull.push(item)
    }

    return {
      sample: {
        ...summary,
        commit_sha: det?.commitSha ?? null,
        input: det?.input ?? null,
        output: det?.output ?? null,
        metadata: (det?.metadata as Record<string, unknown> | null) ?? null,
      },
      feedback: feedback.map((f) => ({
        id: f.id,
        sample_id: f.sampleId,
        comment: f.comment,
        correction: f.correction,
        score: f.score,
        reporter_user_id: f.reporterUserId,
        created_at: isoOrNull(f.createdAt) ?? new Date(0).toISOString(),
      })),
      related: relatedFull,
    }
  }

  // SQLite
  const { gravelSamples, gravelFeedback } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const detailRows = drz
    .select({
      commitSha: gravelSamples.commitSha,
      input: gravelSamples.input,
      output: gravelSamples.output,
      metadata: gravelSamples.metadata,
    })
    .from(gravelSamples)
    .where(eq(gravelSamples.id, sampleId))
    .limit(1)
    .all() as Array<{ commitSha: string | null; input: string | null; output: string | null; metadata: string | null }>
  const det = detailRows[0]
  const feedback = drz
    .select({
      id: gravelFeedback.id,
      sampleId: gravelFeedback.sampleId,
      comment: gravelFeedback.comment,
      correction: gravelFeedback.correction,
      score: gravelFeedback.score,
      reporterUserId: gravelFeedback.reporterUserId,
      createdAt: gravelFeedback.createdAt,
    })
    .from(gravelFeedback)
    .where(eq(gravelFeedback.sampleId, sampleId))
    .orderBy(desc(gravelFeedback.createdAt))
    .all() as Array<{
    id: string
    sampleId: string
    comment: string | null
    correction: string | null
    score: string | null
    reporterUserId: string | null
    createdAt: number
  }>

  const related = summary.group_id
    ? (drz
        .select({ id: gravelSamples.id })
        .from(gravelSamples)
        .where(eq(gravelSamples.groupId, summary.group_id))
        .all() as Array<{ id: string }>).map((r) => r.id)
    : []
  const relatedFull: SampleListItem[] = []
  for (const id of related) {
    if (id === sampleId) continue
    const item = list.samples.find((s) => s.id === id) ?? (await listSampleById(db, id))
    if (item) relatedFull.push(item)
  }

  const meta = parseJson(det?.metadata) as Record<string, unknown> | null
  return {
    sample: {
      ...summary,
      commit_sha: det?.commitSha ?? null,
      input: parseJson(det?.input),
      output: parseJson(det?.output),
      metadata: meta,
    },
    feedback: feedback.map((f) => ({
      id: f.id,
      sample_id: f.sampleId,
      comment: f.comment,
      correction: f.correction,
      score: f.score,
      reporter_user_id: f.reporterUserId,
      created_at: isoOrNull(f.createdAt) ?? new Date(0).toISOString(),
    })),
    related: relatedFull,
  }
}

async function listSampleById(db: Database, sampleId: string): Promise<SampleListItem | null> {
  if (db.dialect === 'postgres') {
    const { gravelSamples, gravelFeedback } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const rows = await drz
      .select({
        id: gravelSamples.id,
        name: gravelSamples.name,
        groupId: gravelSamples.groupId,
        environment: gravelSamples.environment,
        model: gravelSamples.model,
        status: gravelSamples.status,
        startedAt: gravelSamples.startedAt,
        completedAt: gravelSamples.completedAt,
        durationMs: gravelSamples.durationMs,
        metadata: gravelSamples.metadata,
      })
      .from(gravelSamples)
      .where(eq(gravelSamples.id, sampleId))
      .limit(1)
    const r = rows[0]
    if (!r) return null
    const fb = await drz
      .select({ score: gravelFeedback.score })
      .from(gravelFeedback)
      .where(eq(gravelFeedback.sampleId, sampleId))
    const tk = tokensFromMetadata(r.metadata)
    return {
      id: r.id,
      name: r.name,
      model: r.model,
      environment: r.environment,
      status: r.status,
      group_id: r.groupId,
      started_at: isoOrNull(r.startedAt) ?? new Date(0).toISOString(),
      completed_at: isoOrNull(r.completedAt),
      duration_ms: r.durationMs,
      tokens_in: tk.in,
      tokens_out: tk.out,
      feedback_count: fb.length,
      feedback_score: rollUpFeedback(fb.map((f) => f.score)),
    }
  }
  const { gravelSamples, gravelFeedback } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const rows = drz
    .select({
      id: gravelSamples.id,
      name: gravelSamples.name,
      groupId: gravelSamples.groupId,
      environment: gravelSamples.environment,
      model: gravelSamples.model,
      status: gravelSamples.status,
      startedAt: gravelSamples.startedAt,
      completedAt: gravelSamples.completedAt,
      durationMs: gravelSamples.durationMs,
      metadata: gravelSamples.metadata,
    })
    .from(gravelSamples)
    .where(eq(gravelSamples.id, sampleId))
    .limit(1)
    .all()
  const r = rows[0]
  if (!r) return null
  const fb = drz
    .select({ score: gravelFeedback.score })
    .from(gravelFeedback)
    .where(eq(gravelFeedback.sampleId, sampleId))
    .all() as Array<{ score: string | null }>
  const tk = tokensFromMetadata(r.metadata)
  return {
    id: r.id,
    name: r.name,
    model: r.model,
    environment: r.environment,
    status: r.status,
    group_id: r.groupId,
    started_at: isoOrNull(r.startedAt) ?? new Date(0).toISOString(),
    completed_at: isoOrNull(r.completedAt),
    duration_ms: r.durationMs,
    tokens_in: tk.in,
    tokens_out: tk.out,
    feedback_count: fb.length,
    feedback_score: rollUpFeedback(fb.map((f) => f.score)),
  }
}

/** Insert a feedback row. Used by `POST /api/samples/:id/feedback`. */
export async function recordSampleFeedback(
  db: Database,
  args: {
    sampleId: string
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
      sampleId: args.sampleId,
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
        sampleId: args.sampleId,
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
