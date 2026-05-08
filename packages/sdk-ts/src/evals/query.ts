/**
 * Eval-run state queries used by `/api/evals/runs*`.
 *
 * Triggering a run kicks off `runEval` from `./runner.ts` async (don't
 * await — that would block the request for minutes). State updates are
 * persisted to `gravel_eval_runs` as the runner streams results.
 */
import { desc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { Database } from '../db/index.js'

export interface EvalRunSummary {
  id: string
  dataset_id: string
  dataset_name: string
  type: 'trace' | 'live'
  status: 'queued' | 'pending' | 'running' | 'completed' | 'cancelled' | 'errored'
  total_rows: number
  completed_rows: number
  summary: { passed: number; failed: number } | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

function toIso(d: Date | number | string | null | undefined): string | null {
  if (d == null) return null
  if (d instanceof Date) return d.toISOString()
  if (typeof d === 'number') return new Date(d).toISOString()
  return new Date(d).toISOString()
}

function parseSummary(raw: unknown): { passed: number; failed: number } | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { passed?: number; failed?: number }
  if (typeof r.passed !== 'number' || typeof r.failed !== 'number') return null
  return { passed: r.passed, failed: r.failed }
}

export async function listEvalRuns(db: Database): Promise<EvalRunSummary[]> {
  if (db.dialect === 'postgres') {
    const { gravelEvalRuns, gravelDatasets } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const rows = await drz
      .select({
        id: gravelEvalRuns.id,
        datasetId: gravelEvalRuns.datasetId,
        datasetName: gravelDatasets.name,
        type: gravelEvalRuns.type,
        status: gravelEvalRuns.status,
        totalRows: gravelEvalRuns.totalRows,
        completedRows: gravelEvalRuns.completedRows,
        summary: gravelEvalRuns.summary,
        startedAt: gravelEvalRuns.startedAt,
        completedAt: gravelEvalRuns.completedAt,
        createdAt: gravelEvalRuns.createdAt,
      })
      .from(gravelEvalRuns)
      .leftJoin(gravelDatasets, eq(gravelEvalRuns.datasetId, gravelDatasets.id))
      .orderBy(desc(gravelEvalRuns.createdAt))
      .limit(200)
    return rows.map(rowToSummary)
  }
  const { gravelEvalRuns, gravelDatasets } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const rows = drz
    .select({
      id: gravelEvalRuns.id,
      datasetId: gravelEvalRuns.datasetId,
      datasetName: gravelDatasets.name,
      type: gravelEvalRuns.type,
      status: gravelEvalRuns.status,
      totalRows: gravelEvalRuns.totalRows,
      completedRows: gravelEvalRuns.completedRows,
      summary: gravelEvalRuns.summary,
      startedAt: gravelEvalRuns.startedAt,
      completedAt: gravelEvalRuns.completedAt,
      createdAt: gravelEvalRuns.createdAt,
    })
    .from(gravelEvalRuns)
    .leftJoin(gravelDatasets, eq(gravelEvalRuns.datasetId, gravelDatasets.id))
    .orderBy(desc(gravelEvalRuns.createdAt))
    .limit(200)
    .all()
  return rows.map(rowToSummary)
}

function rowToSummary(r: {
  id: string
  datasetId: string
  datasetName: string | null
  type: string
  status: string
  totalRows: number
  completedRows: number
  summary: unknown
  startedAt: Date | number | null
  completedAt: Date | number | null
  createdAt: Date | number
}): EvalRunSummary {
  return {
    id: r.id,
    dataset_id: r.datasetId,
    dataset_name: r.datasetName ?? '(deleted dataset)',
    type: r.type === 'live' ? 'live' : 'trace',
    status: (r.status as EvalRunSummary['status']) ?? 'pending',
    total_rows: r.totalRows ?? 0,
    completed_rows: r.completedRows ?? 0,
    summary: parseSummary(r.summary),
    started_at: toIso(r.startedAt),
    completed_at: toIso(r.completedAt),
    created_at: toIso(r.createdAt) ?? new Date(0).toISOString(),
  }
}

export async function getEvalRun(db: Database, runId: string): Promise<EvalRunSummary | null> {
  const all = await listEvalRuns(db)
  return all.find((r) => r.id === runId) ?? null
}

export async function createEvalRun(
  db: Database,
  args: {
    datasetId: string
    type: 'trace' | 'live'
    triggeredByUserId: string
    totalRows: number
  },
): Promise<{ id: string }> {
  if (db.dialect === 'postgres') {
    const { gravelEvalRuns } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const inserted = await drz
      .insert(gravelEvalRuns)
      .values({
        datasetId: args.datasetId,
        type: args.type,
        status: 'queued',
        triggeredByUserId: args.triggeredByUserId,
        totalRows: args.totalRows,
      })
      .returning({ id: gravelEvalRuns.id })
    return { id: inserted[0]!.id }
  }
  const { gravelEvalRuns } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const id = uuidV4()
  drz
    .insert(gravelEvalRuns)
    .values({
      id,
      datasetId: args.datasetId,
      type: args.type,
      status: 'queued',
      triggeredByUserId: args.triggeredByUserId,
      totalRows: args.totalRows,
    })
    .run()
  return { id }
}

export async function setRunStatus(
  db: Database,
  runId: string,
  status: EvalRunSummary['status'],
  patch?: Partial<{
    completedRows: number
    summary: { passed: number; failed: number }
    startedAt: Date
    completedAt: Date
  }>,
): Promise<void> {
  if (db.dialect === 'postgres') {
    const { gravelEvalRuns } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    await drz
      .update(gravelEvalRuns)
      .set({
        status,
        ...(patch?.completedRows !== undefined && { completedRows: patch.completedRows }),
        ...(patch?.summary && { summary: patch.summary }),
        ...(patch?.startedAt && { startedAt: patch.startedAt }),
        ...(patch?.completedAt && { completedAt: patch.completedAt }),
      })
      .where(eq(gravelEvalRuns.id, runId))
    return
  }
  const { gravelEvalRuns } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  drz
    .update(gravelEvalRuns)
    .set({
      status,
      ...(patch?.completedRows !== undefined && { completedRows: patch.completedRows }),
      ...(patch?.summary && { summary: JSON.stringify(patch.summary) }),
      ...(patch?.startedAt && { startedAt: patch.startedAt.getTime() }),
      ...(patch?.completedAt && { completedAt: patch.completedAt.getTime() }),
    })
    .where(eq(gravelEvalRuns.id, runId))
    .run()
}

void sql // kept for future ad-hoc filters

function uuidV4(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
