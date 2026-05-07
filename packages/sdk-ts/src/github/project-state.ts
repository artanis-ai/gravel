/**
 * Project-level GitHub App install state. Written by
 * `/api/github/install/callback` once the dev installs gravel-bot on
 * their repo; read by `prompts/submit.ts` on every PR creation.
 *
 * The customer's DB has a single `gravel_projects` row keyed by
 * `process.env.GRAVEL_PROJECT_ID`. The SDK is single-tenant per install
 * — the upsert below is unconditional.
 */
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { Database } from '../db/index.js'

export interface GhInstallState {
  installationId: number
  repoOwner: string
  repoName: string
  /** JWT issued by the control plane; carry as bearer when minting. */
  bindingToken: string
  /** When the dev clicked Install. ISO-8601. */
  installedAt: string
}

function getProjectId(): string {
  const id = process.env.GRAVEL_PROJECT_ID
  if (!id) throw new Error('GRAVEL_PROJECT_ID not set')
  return id
}

export async function getGhInstallState(db: Database): Promise<GhInstallState | null> {
  const projectId = getProjectId()
  type Row = {
    installationId: number | null
    repoOwner: string | null
    repoName: string | null
    bindingToken: string | null
    installedAt: Date | number | null
  }
  let row: Row | undefined
  if (db.dialect === 'postgres') {
    const { gravelProjects } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const rows = await drz
      .select({
        installationId: gravelProjects.ghInstallationId,
        repoOwner: gravelProjects.ghRepoOwner,
        repoName: gravelProjects.ghRepoName,
        bindingToken: gravelProjects.ghBindingToken,
        installedAt: gravelProjects.ghInstalledAt,
      })
      .from(gravelProjects)
      .where(eq(gravelProjects.id, projectId))
      .limit(1)
    row = rows[0] as Row | undefined
  } else {
    const { gravelProjects } = await import('../schema/sqlite.js')
    const drz = db.drizzle as BetterSQLite3Database
    const rows = drz
      .select({
        installationId: gravelProjects.ghInstallationId,
        repoOwner: gravelProjects.ghRepoOwner,
        repoName: gravelProjects.ghRepoName,
        bindingToken: gravelProjects.ghBindingToken,
        installedAt: gravelProjects.ghInstalledAt,
      })
      .from(gravelProjects)
      .where(eq(gravelProjects.id, projectId))
      .limit(1)
      .all()
    row = rows[0] as Row | undefined
  }
  if (!row || row.installationId == null || !row.repoOwner || !row.repoName || !row.bindingToken) {
    return null
  }
  const installedAtIso =
    row.installedAt instanceof Date
      ? row.installedAt.toISOString()
      : typeof row.installedAt === 'number'
        ? new Date(row.installedAt).toISOString()
        : new Date().toISOString()
  return {
    installationId: row.installationId,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    bindingToken: row.bindingToken,
    installedAt: installedAtIso,
  }
}

/**
 * Upsert the install state. The `name` column on gravel_projects is
 * NOT NULL, so we seed it from GRAVEL_PROJECT_NAME (or the project_id
 * itself) when inserting a fresh row. The control plane is the source
 * of truth for the human-friendly name; this is only a fallback.
 */
export async function setGhInstallState(db: Database, state: GhInstallState): Promise<void> {
  const projectId = getProjectId()
  const fallbackName = process.env.GRAVEL_PROJECT_NAME ?? projectId
  const installedAtPg = new Date(state.installedAt)
  const installedAtSqlite = installedAtPg.getTime()

  if (db.dialect === 'postgres') {
    const { gravelProjects } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const existing = await drz
      .select({ id: gravelProjects.id })
      .from(gravelProjects)
      .where(eq(gravelProjects.id, projectId))
      .limit(1)
    if (existing.length === 0) {
      await drz.insert(gravelProjects).values({
        id: projectId,
        name: fallbackName,
        ghInstallationId: state.installationId,
        ghRepoOwner: state.repoOwner,
        ghRepoName: state.repoName,
        ghBindingToken: state.bindingToken,
        ghInstalledAt: installedAtPg,
      })
    } else {
      await drz
        .update(gravelProjects)
        .set({
          ghInstallationId: state.installationId,
          ghRepoOwner: state.repoOwner,
          ghRepoName: state.repoName,
          ghBindingToken: state.bindingToken,
          ghInstalledAt: installedAtPg,
        })
        .where(eq(gravelProjects.id, projectId))
    }
    return
  }

  const { gravelProjects } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const existing = drz
    .select({ id: gravelProjects.id })
    .from(gravelProjects)
    .where(eq(gravelProjects.id, projectId))
    .limit(1)
    .all()
  if (existing.length === 0) {
    drz
      .insert(gravelProjects)
      .values({
        id: projectId,
        name: fallbackName,
        ghInstallationId: state.installationId,
        ghRepoOwner: state.repoOwner,
        ghRepoName: state.repoName,
        ghBindingToken: state.bindingToken,
        ghInstalledAt: installedAtSqlite,
      })
      .run()
    return
  }
  drz
    .update(gravelProjects)
    .set({
      ghInstallationId: state.installationId,
      ghRepoOwner: state.repoOwner,
      ghRepoName: state.repoName,
      ghBindingToken: state.bindingToken,
      ghInstalledAt: installedAtSqlite,
    })
    .where(eq(gravelProjects.id, projectId))
    .run()
}
