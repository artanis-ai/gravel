/**
 * Dumps a normalized text representation of the schema. The schema-drift CI
 * runs this for both TS and Python and diffs the outputs.
 *
 * Format: a deterministic, language-agnostic textual schema dump. Columns
 * sorted, types normalized to a shared vocabulary, FK targets canonicalized.
 *
 * This is the canonical schema spec for cross-language equivalence checks.
 */
import { allTables as pgTables } from './postgres.js'

interface ColumnRow {
  name: string
  type: string
  notNull: boolean
  defaultValue: string | null
  references: string | null
}

function normalizeColumn(col: any): ColumnRow {
  // Map drizzle column types to a normalized vocabulary used in both TS + Py.
  const dataType = col.dataType ?? col.columnType ?? 'unknown'
  const sqlName = col.name as string
  let normalized: string
  switch (dataType) {
    case 'string':
      normalized = 'text'
      break
    case 'json':
      normalized = 'json' // jsonb in pg, text(json) in sqlite — same semantic
      break
    case 'date':
      normalized = 'timestamp'
      break
    case 'bigint':
    case 'number':
      normalized = 'integer'
      break
    case 'boolean':
      normalized = 'boolean'
      break
    default:
      normalized = String(dataType)
  }
  return {
    name: sqlName,
    type: normalized,
    notNull: !!col.notNull,
    defaultValue: col.default ? '<has-default>' : null,
    references: col.references ? canonicalizeRef(col.references) : null,
  }
}

function canonicalizeRef(ref: any): string {
  // Drizzle FKs may be a function or an object. Normalize to "<table>.<col>".
  try {
    const target = typeof ref === 'function' ? ref() : ref
    return `${target.table?.name ?? '?'}.${target.name ?? '?'}`
  } catch {
    return '<fk>'
  }
}

function dumpTable(name: string, table: any): string {
  const cols: ColumnRow[] = Object.entries(table)
    .filter(([key]) => !key.startsWith('_'))
    .map(([, col]) => normalizeColumn(col))
    .sort((a, b) => a.name.localeCompare(b.name))

  const lines = [`TABLE ${name}`]
  for (const col of cols) {
    const flags: string[] = []
    if (col.notNull) flags.push('NOT NULL')
    if (col.defaultValue) flags.push('DEFAULT')
    if (col.references) flags.push(`FK -> ${col.references}`)
    lines.push(`  ${col.name} ${col.type}${flags.length ? ' ' + flags.join(' ') : ''}`)
  }
  return lines.join('\n')
}

function dump(): string {
  const sortedNames = Object.keys(pgTables).sort()
  return sortedNames.map((name) => dumpTable(name, (pgTables as any)[name])).join('\n\n') + '\n'
}

console.log(dump())
