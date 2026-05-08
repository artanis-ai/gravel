/**
 * Datasets — collections of traces flagged for review or eval. Read +
 * write helpers used by `/api/datasets*` routes.
 *
 * Shape matches `packages/dashboard/src/lib/types.ts ::
 * DatasetSummary / DatasetsResponse / DatasetDetailResponse`.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { Database } from '../db/index.js'

export interface DatasetSummary {
  id: string
  name: string
  description: string | null
  trace_count: number
  updated_at: string
  created_at: string
}

function toIso(d: Date | number | string | null | undefined): string {
  if (d == null) return new Date(0).toISOString()
  if (d instanceof Date) return d.toISOString()
  if (typeof d === 'number') return new Date(d).toISOString()
  return new Date(d).toISOString()
}

export async function listDatasets(db: Database): Promise<DatasetSummary[]> {
  if (db.dialect === 'postgres') {
    const { gravelDatasets, gravelDatasetTraces } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const rows = await drz
      .select({
        id: gravelDatasets.id,
        name: gravelDatasets.name,
        description: gravelDatasets.description,
        createdAt: gravelDatasets.createdAt,
        updatedAt: gravelDatasets.updatedAt,
        traceCount: sql<number>`(SELECT count(*)::int FROM ${gravelDatasetTraces} WHERE ${gravelDatasetTraces.datasetId} = ${gravelDatasets.id})`,
      })
      .from(gravelDatasets)
      .where(isNull(gravelDatasets.deletedAt))
      .orderBy(desc(gravelDatasets.updatedAt))
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      trace_count: r.traceCount,
      updated_at: toIso(r.updatedAt),
      created_at: toIso(r.createdAt),
    }))
  }
  const { gravelDatasets, gravelDatasetTraces } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const rows = drz
    .select({
      id: gravelDatasets.id,
      name: gravelDatasets.name,
      description: gravelDatasets.description,
      createdAt: gravelDatasets.createdAt,
      updatedAt: gravelDatasets.updatedAt,
      traceCount: sql<number>`(SELECT count(*) FROM ${gravelDatasetTraces} WHERE ${gravelDatasetTraces.datasetId} = ${gravelDatasets.id})`,
    })
    .from(gravelDatasets)
    .where(isNull(gravelDatasets.deletedAt))
    .orderBy(desc(gravelDatasets.updatedAt))
    .all() as Array<{
    id: string
    name: string
    description: string | null
    createdAt: number
    updatedAt: number
    traceCount: number
  }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    trace_count: r.traceCount,
    updated_at: toIso(r.updatedAt),
    created_at: toIso(r.createdAt),
  }))
}

export async function createDataset(
  db: Database,
  args: { name: string; description?: string | null; createdByUserId: string },
): Promise<{ id: string }> {
  if (db.dialect === 'postgres') {
    const { gravelDatasets } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const inserted = await drz
      .insert(gravelDatasets)
      .values({
        name: args.name,
        description: args.description ?? null,
        createdByUserId: args.createdByUserId,
      })
      .returning({ id: gravelDatasets.id })
    return { id: inserted[0]!.id }
  }
  const { gravelDatasets } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  // SQLite: use a UUIDv4-ish id since the table type is text.
  const id = uuidV4()
  drz
    .insert(gravelDatasets)
    .values({
      id,
      name: args.name,
      description: args.description ?? null,
      createdByUserId: args.createdByUserId,
    })
    .run()
  return { id }
}

export async function addTraceToDataset(
  db: Database,
  args: { datasetId: string; traceId: string },
): Promise<{ id: string }> {
  if (db.dialect === 'postgres') {
    const { gravelDatasetTraces, gravelDatasets } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    // Bump the dataset's updatedAt so it sorts to the top of the list.
    await drz
      .update(gravelDatasets)
      .set({ updatedAt: new Date() })
      .where(eq(gravelDatasets.id, args.datasetId))
    const inserted = await drz
      .insert(gravelDatasetTraces)
      .values({ datasetId: args.datasetId, traceId: args.traceId })
      .returning({ id: gravelDatasetTraces.id })
    return { id: inserted[0]!.id }
  }
  const { gravelDatasetTraces, gravelDatasets } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  drz
    .update(gravelDatasets)
    .set({ updatedAt: Date.now() })
    .where(eq(gravelDatasets.id, args.datasetId))
    .run()
  const id = uuidV4()
  drz
    .insert(gravelDatasetTraces)
    .values({ id, datasetId: args.datasetId, traceId: args.traceId })
    .run()
  return { id }
}

function uuidV4(): string {
  // Inline so we don't drag the `crypto` import boundary into the SQLite path.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

void and // keep import — used by future filters
