/**
 * Pure formatting helpers (kept tiny, no deps).
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = now.getTime() - t
  const abs = Math.abs(diff)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const past = diff >= 0
  const suffix = past ? 'ago' : 'from now'
  if (abs < minute) return past ? 'just now' : 'in a moment'
  if (abs < hour) return `${Math.round(abs / minute)}m ${suffix}`
  if (abs < day) return `${Math.round(abs / hour)}h ${suffix}`
  if (abs < 7 * day) return `${Math.round(abs / day)}d ${suffix}`
  return new Date(iso).toLocaleDateString()
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function truncate(s: string | null | undefined, max = 80): string {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

export function asString(value: unknown, max = 80): string {
  if (value == null) return ''
  if (typeof value === 'string') return truncate(value, max)
  try {
    return truncate(JSON.stringify(value), max)
  } catch {
    return ''
  }
}
