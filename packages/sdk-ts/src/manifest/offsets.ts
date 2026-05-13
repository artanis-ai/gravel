/**
 * Offset arithmetic for prompt manifests.
 *
 * Manifest `charStart` / `charEnd` are Unicode CODE-POINT indices into
 * the source file content. Not UTF-16 code units (JS / TS native) and
 * not UTF-8 bytes (Go native). Code points are the only unit that
 * matches across all three SDK languages without conversion math at
 * every read/write boundary — Python's `str[a:b]` is already code
 * points, so picking code points lets the SDK handler slice manifest
 * entries directly.
 *
 * Use these helpers wherever a manifest offset is read or written.
 * Never pass a manifest offset to plain `string.slice()` — that uses
 * UTF-16 code units and will split surrogate pairs (any astral char,
 * including 🎯 and most emoji, takes two code units).
 *
 * The Go counterparts live in `cli/internal/manifest/offsets.go`.
 */

/** Number of Unicode code points in `s`. */
export function codePointLength(s: string): number {
  let n = 0
  // for…of iterates by code point, surrogate-pair safe.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++
  return n
}

/**
 * Substring of `s` from code-point index `cpStart` (inclusive) to
 * `cpEnd` (exclusive). Out-of-range indices clamp to
 * `[0, codePointLength(s)]`. Empty string for empty / inverted ranges.
 */
export function sliceByCodePoints(s: string, cpStart: number, cpEnd: number): string {
  if (cpStart < 0) cpStart = 0
  if (cpEnd < cpStart) cpEnd = cpStart
  let cp = 0
  let unitOff = 0
  let unitStart = -1
  let unitEnd = -1
  for (const ch of s) {
    if (cp === cpStart && unitStart < 0) unitStart = unitOff
    if (cp === cpEnd) {
      unitEnd = unitOff
      break
    }
    unitOff += ch.length // 1 for BMP, 2 for surrogate pair
    cp++
  }
  if (unitStart < 0) {
    // cpStart at or past end of string.
    if (cpStart === cp) return ''
    return ''
  }
  if (unitEnd < 0) unitEnd = s.length
  return s.slice(unitStart, unitEnd)
}

/**
 * Convert a UTF-16 code-unit index (what JS strings natively use) to
 * a Unicode code-point index. Code units that land mid-surrogate-pair
 * snap to the next code point.
 */
export function codeUnitToCodePoint(s: string, unitIdx: number): number {
  if (unitIdx <= 0) return 0
  let cp = 0
  let off = 0
  for (const ch of s) {
    if (off >= unitIdx) return cp
    off += ch.length
    cp++
  }
  return cp
}

/** Convert a code-point index to its UTF-16 code-unit index. */
export function codePointToCodeUnit(s: string, cp: number): number {
  if (cp <= 0) return 0
  let n = 0
  let off = 0
  for (const ch of s) {
    if (n === cp) return off
    off += ch.length
    n++
  }
  return s.length
}

/**
 * Code-point offset of the start of the (0-indexed) line N. `line == 0`
 * returns 0. Past EOF returns -1; the "trailing line with no \n" case
 * returns `codePointLength(s)` for `line == lineCount`.
 */
export function lineToCodePointOffset(s: string, line: number): number {
  if (line < 0) return -1
  if (line === 0) return 0
  let cp = 0
  let lc = 0
  for (const ch of s) {
    if (ch === '\n') {
      cp++
      lc++
      if (lc === line) return cp
      continue
    }
    cp++
  }
  if (lc === line - 1) return cp
  if (lc >= line) return cp
  return -1
}

/**
 * Code-point [start, end) bounds of (1-indexed) line N — `end` is one
 * past the line's last non-newline character. Returns `[-1, -1]` past
 * EOF or for non-positive `line`. Use this to bound an anchored
 * substring search to a single line.
 */
export function lineContentCodePoints(s: string, line: number): [number, number] {
  if (line < 1) return [-1, -1]
  const start = lineToCodePointOffset(s, line - 1)
  if (start < 0) return [-1, -1]
  const nextLineStart = lineToCodePointOffset(s, line)
  if (nextLineStart < 0) return [-1, -1]
  let end = nextLineStart
  if (end > start && sliceByCodePoints(s, end - 1, end) === '\n') end--
  return [start, end]
}
