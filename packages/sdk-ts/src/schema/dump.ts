/**
 * Dumps a normalized text representation of the schema. The schema-drift CI
 * runs this for both TS and Python and diffs the outputs.
 *
 * Format (kept in lockstep with `python/gravel/.../schema_dump.py`):
 *
 *     TABLE <sql_table_name>
 *       <col_name> <normalized_type> [NOT NULL] [DEFAULT] [FK -> <table>.<col>]
 *       …
 *
 *     TABLE …
 *
 * Tables are sorted by SQL name. Columns within a table sorted by name.
 * Primary keys are not annotated NOT NULL (treated as implicit) — matches
 * the Python side.
 */
import { getTableColumns, getTableName } from 'drizzle-orm'
import type { ForeignKey } from 'drizzle-orm/pg-core'
import { allTables as pgTables } from './postgres.js'

interface ColumnRow {
  name: string
  type: string
  isPrimaryKey: boolean
  notNull: boolean
  hasDefault: boolean
  references: string | null
}

function normalizeType(col: { dataType?: string; columnType?: string }): string {
  const raw = (col.dataType ?? col.columnType ?? 'unknown').toString()
  switch (raw) {
    case 'string':
      return 'text'
    case 'json':
      return 'json'
    case 'date':
      return 'timestamp'
    case 'bigint':
    case 'number':
      return 'integer'
    case 'boolean':
      return 'boolean'
    default:
      return raw
  }
}

function describeFK(table: unknown, columnName: string): string | null {
  // Drizzle stores FK metadata on the table object via Symbol-keyed slots.
  // `getTableConfig(table).foreignKeys` would be the public accessor, but
  // we only need to find FKs whose source column matches `columnName`.
  const symbols = Object.getOwnPropertySymbols(table)
  for (const sym of symbols) {
    const value = (table as Record<symbol, unknown>)[sym]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          item &&
          typeof item === 'object' &&
          'reference' in item &&
          typeof (item as { reference: unknown }).reference === 'function'
        ) {
          try {
            const ref = (item as ForeignKey).reference()
            const sources = ref.columns
            const targets = ref.foreignColumns
            for (let i = 0; i < sources.length; i++) {
              if (sources[i]?.name === columnName) {
                const target = targets[i]
                if (target) {
                  return `${getTableName(target.table)}.${target.name}`
                }
              }
            }
          } catch {
            // Skip on any introspection error.
          }
        }
      }
    }
  }
  return null
}

function dumpTable(table: unknown): string {
  const sqlName = getTableName(table as Parameters<typeof getTableName>[0])
  const columns = getTableColumns(table as Parameters<typeof getTableColumns>[0])
  const rows: ColumnRow[] = Object.values(columns)
    .map((col) => {
      const c = col as {
        name: string
        notNull: boolean
        hasDefault: boolean
        primary: boolean
        dataType?: string
        columnType?: string
      }
      return {
        name: c.name,
        type: normalizeType(c),
        isPrimaryKey: !!c.primary,
        notNull: !!c.notNull,
        hasDefault: !!c.hasDefault,
        references: describeFK(table, c.name),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const lines: string[] = [`TABLE ${sqlName}`]
  for (const col of rows) {
    const flags: string[] = []
    // Match Python: don't annotate primary keys as NOT NULL or DEFAULT
    // (those are implicit there).
    if (col.notNull && !col.isPrimaryKey) flags.push('NOT NULL')
    if (col.hasDefault && !col.isPrimaryKey) flags.push('DEFAULT')
    if (col.references) flags.push(`FK -> ${col.references}`)
    lines.push(`  ${col.name} ${col.type}${flags.length ? ' ' + flags.join(' ') : ''}`)
  }
  return lines.join('\n')
}

function dump(): string {
  const tables = Object.values(pgTables)
  const sorted = [...tables].sort((a, b) =>
    getTableName(a as Parameters<typeof getTableName>[0]).localeCompare(
      getTableName(b as Parameters<typeof getTableName>[0]),
    ),
  )
  return sorted.map((t) => dumpTable(t)).join('\n\n') + '\n'
}

process.stdout.write(dump())
