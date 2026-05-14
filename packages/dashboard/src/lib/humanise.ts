/**
 * Key-humanisation + light heuristics for the Review surface.
 *
 * Pure functions only — kept out of components so renderers and
 * tests can share them. Anything that returns React goes under
 * `src/components/review/`.
 */

/** Turn a snake_case / camelCase / kebab-case identifier into a
 *  Title-Cased human label. Acronyms stay upper-cased.
 *
 *  Examples: `prompt_tokens` → "Prompt Tokens",
 *  `inputTokens` → "Input Tokens", `request_id` → "Request ID",
 *  `tool-use` → "Tool Use", `gpt4o_mini` → "Gpt4o Mini".
 */
export function humaniseKey(key: string): string {
  if (!key) return ''
  // Insert spaces in camelCase: aB → a B
  const spaced = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return spaced
    .split(/\s+/)
    .map((word) => {
      const upper = word.toUpperCase()
      if (ACRONYMS.has(upper)) return upper
      if (word.length === 0) return word
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
}

const ACRONYMS = new Set([
  'ID',
  'URL',
  'URI',
  'API',
  'HTTP',
  'HTTPS',
  'JSON',
  'XML',
  'SQL',
  'UUID',
  'IP',
  'PR',
  'AI',
  'ML',
  'LLM',
  'SDK',
  'CDN',
  'TTL',
  'MIME',
  'PDF',
  'OCR',
  'OS',
  'CPU',
  'GPU',
  'RAM',
  'IO',
  'TLS',
  'JWT',
  'OAuth',
  'MCP',
])

/** Approximate byte length of a string (good enough for "show this is
 *  X KB"). Counts UTF-8 bytes by re-encoding. Falls back to `length`
 *  when TextEncoder isn't available. */
export function approxByteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    try {
      return new TextEncoder().encode(s).length
    } catch {
      // fall through
    }
  }
  return s.length
}

/** Human-readable byte count. `1234` → `"1.2 KB"`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Heuristic: is this string almost certainly a base64-encoded blob
 *  (long, only `A-Za-z0-9+/=`)? Used to decide whether to truncate
 *  + offer a "show full" affordance in HumanValue. */
export function looksLikeBase64(s: string): boolean {
  if (s.length < 80) return false
  // Trim trailing padding / whitespace.
  const trimmed = s.replace(/\s+$/g, '')
  if (trimmed.length < 80) return false
  // Sample the first 200 chars — full scan is wasteful for huge blobs.
  const sample = trimmed.slice(0, 200)
  return /^[A-Za-z0-9+/=]+$/.test(sample)
}

/** Heuristic: is this string a `data:` URI we can render inline
 *  (image / audio)? */
export function dataUriKind(s: string): 'image' | 'audio' | null {
  if (!s.startsWith('data:')) return null
  if (/^data:image\//.test(s)) return 'image'
  if (/^data:audio\//.test(s)) return 'audio'
  return null
}

/** Heuristic: is this string an http(s) URL we should linkify? */
export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(s)
}

/** Tally common token-usage keys from a `usage` object across
 *  providers. Returns null if no recognisable tokens are present. */
export function tokensFromUsage(usage: unknown): {
  input: number | null
  output: number | null
  total: number | null
} | null {
  if (!isPlainObject(usage)) return null
  const input =
    pickNumber(usage, [
      'input_tokens',
      'inputTokens',
      'prompt_tokens',
      'promptTokens',
    ]) ?? null
  const output =
    pickNumber(usage, [
      'output_tokens',
      'outputTokens',
      'completion_tokens',
      'completionTokens',
    ]) ?? null
  const total = pickNumber(usage, ['total_tokens', 'totalTokens']) ?? null
  if (input === null && output === null && total === null) return null
  return { input, output, total }
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
