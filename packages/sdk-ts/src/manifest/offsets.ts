/**
 * Shared line ↔ char-offset helpers. Used by:
 *   - `agent-deep-scan.ts` to enrich agent-reported line numbers with
 *     the half-open byte ranges the manifest stores
 *   - `wizard/index.ts` for the manual "specify a file by line range"
 *     path
 *
 * Lines are 1-indexed externally (matches editor / agent conventions);
 * the helpers take 0-indexed line numbers internally so callers can
 * walk a file without thinking about off-by-one.
 */

/**
 * Returns the character offset of the start of line `lineIndex`
 * (0-indexed). When `lineIndex` is past the last line, returns the
 * length of the text (so a [start, end) slice spanning the final line
 * still works). Returns -1 for negative inputs only.
 */
export function lineToCharOffset(text: string, lineIndex: number): number {
  if (lineIndex < 0) return -1
  let line = 0
  let i = 0
  while (i < text.length) {
    if (line === lineIndex) return i
    if (text[i] === '\n') line++
    i++
  }
  if (line === lineIndex) return i
  return -1
}
