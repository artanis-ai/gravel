/**
 * Stdin Y/n prompt helper. Used by the wizard to ask for consent before
 * destructive actions (creating tables, modifying configs, etc).
 *
 * Convention: returns the user's choice (true/false). When stdin is not
 * a TTY (CI / piped / agent contexts), the default value is returned —
 * caller decides whether default-yes or default-no is right.
 *
 * The visual treatment is the clack-style rail: an active diamond + the
 * question, then a `│  ` input rail under it. After the user answers,
 * the two lines are rewritten as a single dim summary so the wizard's
 * trail stays clean. See `wizard/ui.ts` for the underlying helpers.
 *
 * Test seam: pass `input` / `output` / `isTTY` to override.
 */
import { createInterface } from 'node:readline'
import { c, rewriteAnswer, sym } from './ui.js'

export interface ConfirmOptions {
  /** Default answer when the user just presses Enter (or stdin is not a TTY). */
  defaultYes?: boolean
  /** Override TTY detection (test injection). */
  isTTY?: boolean
  /** Override stdin (test injection). */
  input?: NodeJS.ReadableStream
  /** Override stdout (test injection). */
  output?: NodeJS.WritableStream
}

const HAS_COLOR =
  (process.stdout as NodeJS.WriteStream).isTTY === true && !process.env.NO_COLOR

export async function confirm(question: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const defaultYes = opts.defaultYes ?? true
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const isTTY = opts.isTTY ?? (process.stdin as NodeJS.ReadStream).isTTY === true
  if (!isTTY) return defaultYes

  const yn = defaultYes ? '[Y/n]' : '[y/N]'
  // Two-line layout: question with the active diamond on top, input
  // prompt with the rail below. We then collapse both into one dim
  // summary line via rewriteAnswer().
  const headLine = HAS_COLOR
    ? `${c.brand(sym.active)}  ${c.bold(question)} ${c.dim(yn)}\n`
    : `${question} ${yn}\n`
  const railPrompt = HAS_COLOR ? `${c.dim(sym.rail)}  ` : '> '

  output.write(headLine)
  const rl = createInterface({ input, output })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(railPrompt, (a) => resolve(a.trim().toLowerCase()))
    })
    const result = answer === '' ? defaultYes : answer.startsWith('y')
    if (HAS_COLOR && output === process.stdout) {
      rewriteAnswer(`${question} ${yn}`, result ? 'yes' : 'no')
    }
    return result
  } finally {
    rl.close()
  }
}
