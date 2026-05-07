/**
 * Tiny stdin Y/n prompt helper. Used by the wizard to ask for consent
 * before destructive actions (creating tables, modifying configs, etc).
 *
 * Convention: returns the user's choice (true/false). When stdin is not
 * a TTY (CI / piped / agent contexts), the default value is returned —
 * caller decides whether default-yes or default-no is right.
 *
 * Test seam: pass `input` / `output` / `isTTY` to override.
 */
import { createInterface } from 'node:readline'

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

export async function confirm(question: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const defaultYes = opts.defaultYes ?? true
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const isTTY = opts.isTTY ?? (process.stdin as NodeJS.ReadStream).isTTY === true
  if (!isTTY) return defaultYes

  const yn = defaultYes ? '[Y/n]' : '[y/N]'
  const prompt = `${question} ${yn} `

  const rl = createInterface({ input, output })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, (a) => resolve(a.trim().toLowerCase()))
    })
    if (answer === '') return defaultYes
    return answer.startsWith('y')
  } finally {
    rl.close()
  }
}
