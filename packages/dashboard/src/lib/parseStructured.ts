/**
 * Parse a string that might be either JSON or a Python literal repr.
 *
 * LangChain (Python) hands tool callbacks `input_str` as
 * `str(kwargs_dict)` — a Python repr (single quotes, `True/False/None`)
 * rather than JSON. The dashboard wants to render the structured value,
 * not the raw repr.
 *
 * Strategy:
 *   1. Try JSON.parse — covers properly-encoded payloads.
 *   2. Walk the string as a Python literal, flipping single-quoted
 *      tokens to double-quoted ones and rewriting True/False/None
 *      to their JSON equivalents, then JSON.parse the rewritten
 *      string.
 *   3. Bail back to the original string if neither yields a value.
 *
 * Bails (returns the original string) on:
 *   - Anything that doesn't start with `{` or `[`.
 *   - Mid-string apostrophes Python would have escaped — we skip
 *     conservatively rather than corrupting the value.
 */

export function tryParseStructuredString(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const trimmed = v.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return v
  // 1. JSON.
  try {
    return JSON.parse(v)
  } catch {
    // fall through
  }
  // 2. Python repr.
  const rewritten = rewritePythonReprToJson(v)
  if (rewritten !== null) {
    try {
      return JSON.parse(rewritten)
    } catch {
      // fall through
    }
  }
  return v
}

/** Tokenise a Python literal and emit JSON. Returns `null` if the
 *  walker hits a structure it can't safely rewrite (so the caller
 *  can fall back to the raw string instead of returning garbage). */
function rewritePythonReprToJson(s: string): string | null {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === "'") {
      // Single-quoted string. Python escapes internal `'` as `\'`
      // and uses double-quotes as the outer style if the body
      // contains `'` itself — so a `'` inside a single-quoted body
      // is always either escaped or terminates the literal.
      let j = i + 1
      let body = ''
      while (j < s.length) {
        const cj = s[j]!
        if (cj === '\\' && j + 1 < s.length) {
          const next = s[j + 1]!
          if (next === "'") {
            body += "'"
            j += 2
            continue
          }
          if (next === '"') {
            body += '\\"'
            j += 2
            continue
          }
          body += cj + next
          j += 2
          continue
        }
        if (cj === '"') {
          body += '\\"'
          j++
          continue
        }
        if (cj === "'") break
        body += cj
        j++
      }
      if (j >= s.length) return null // unterminated
      out += '"' + body + '"'
      i = j + 1
      continue
    }
    if (c === '"') {
      // Double-quoted string. Copy verbatim respecting escapes.
      let j = i + 1
      out += '"'
      while (j < s.length) {
        const cj = s[j]!
        if (cj === '\\' && j + 1 < s.length) {
          out += cj + s[j + 1]!
          j += 2
          continue
        }
        if (cj === '"') break
        out += cj
        j++
      }
      if (j >= s.length) return null
      out += '"'
      i = j + 1
      continue
    }
    // Outside any string body — match Python literals.
    if (matchAt(s, i, 'True')) {
      out += 'true'
      i += 4
      continue
    }
    if (matchAt(s, i, 'False')) {
      out += 'false'
      i += 5
      continue
    }
    if (matchAt(s, i, 'None')) {
      out += 'null'
      i += 4
      continue
    }
    out += c
    i++
  }
  return out
}

function matchAt(s: string, i: number, token: string): boolean {
  if (s.slice(i, i + token.length) !== token) return false
  const prev = i > 0 ? s[i - 1]! : ''
  const next = i + token.length < s.length ? s[i + token.length]! : ''
  // Must be a standalone token (boundary on both sides).
  return !isWordChar(prev) && !isWordChar(next)
}

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c)
}
