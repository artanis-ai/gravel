/**
 * Token-level diff between two strings, rendered inline.
 *
 *
 * Algorithm: classic O(N*M) LCS over whitespace-aware tokens (words,
 * runs of whitespace, single punctuation chars), then emit
 * keep/insert/remove ops by walking the LCS table. N*M memory; for the
 * realistic prompt sizes Gravel deals with (low thousands of tokens
 * each side) this is well under a millisecond per diff.
 */
import { useMemo } from 'react'

export type DiffOp = 'keep' | 'insert' | 'remove'

export interface DiffSegment {
  op: DiffOp
  text: string
}

/**
 * Tokenise so word boundaries land between added/removed regions.
 * Each token is one of: a word ([A-Za-z0-9_]+), a whitespace run, or a
 * single non-word character. Joining the tokens reproduces the input
 * byte-for-byte.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  const re = /[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) !== null) tokens.push(match[0])
  return tokens
}

export function diffTokens(a: string[], b: string[]): DiffSegment[] {
  const n = a.length
  const m = b.length

  // Build LCS length table.
  const lcs: Uint32Array = new Uint32Array((n + 1) * (m + 1))
  const w = m + 1
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        lcs[i * w + j] = lcs[(i + 1) * w + (j + 1)] + 1
      } else {
        const down = lcs[(i + 1) * w + j]
        const right = lcs[i * w + (j + 1)]
        lcs[i * w + j] = down > right ? down : right
      }
    }
  }

  const out: DiffSegment[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pushSeg(out, 'keep', a[i]!)
      i++
      j++
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + (j + 1)]) {
      pushSeg(out, 'remove', a[i]!)
      i++
    } else {
      pushSeg(out, 'insert', b[j]!)
      j++
    }
  }
  while (i < n) {
    pushSeg(out, 'remove', a[i]!)
    i++
  }
  while (j < m) {
    pushSeg(out, 'insert', b[j]!)
    j++
  }
  return out
}

function pushSeg(arr: DiffSegment[], op: DiffOp, text: string) {
  const last = arr[arr.length - 1]
  if (last && last.op === op) last.text += text
  else arr.push({ op, text })
}

export function diffStrings(before: string, after: string): DiffSegment[] {
  return diffTokens(tokenize(before), tokenize(after))
}

export function DiffView({
  before,
  after,
  className,
}: {
  before: string
  after: string
  className?: string
}) {
  const segments = useMemo(() => diffStrings(before, after), [before, after])
  return (
    <pre
      className={
        className ??
        'overflow-auto whitespace-pre-wrap rounded-xl border border-warm bg-cream p-3 font-mono text-xs leading-relaxed'
      }
      data-testid="diff-view"
    >
      {segments.map((seg, i) => {
        if (seg.op === 'keep') return <span key={i}>{seg.text}</span>
        if (seg.op === 'insert')
          return (
            <ins
              key={i}
              className="bg-forest/15 text-forest no-underline decoration-forest decoration-2 underline"
              data-op="insert"
            >
              {seg.text}
            </ins>
          )
        return (
          <del
            key={i}
            className="bg-primary/10 text-primary-dark line-through decoration-primary-dark"
            data-op="remove"
          >
            {seg.text}
          </del>
        )
      })}
    </pre>
  )
}
