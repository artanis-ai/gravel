/**
 * Stdin prompt helpers. Used by the wizard's per-pillar conversation.
 *
 * Two shapes:
 *   - `confirm()` — Y/n, default-yes. Single inline line, e.g.
 *     `Continue? [Y/n] ` with the user's typed answer immediately
 *     after.
 *   - `askText()` — free-form text. Used for "which prompts to skip?"
 *     style follow-ups.
 *   - `pressEnter()` — pause for the user to look at something
 *     (e.g. open the dashboard) and hit Enter when ready.
 *
 * On non-TTY (CI / piped / agent contexts), `confirm` returns the
 * default and `pressEnter` is a no-op so the wizard runs unattended.
 *
 * Test seam: pass `input` / `output` / `isTTY` to override.
 */
import { createInterface } from 'node:readline'
import { c, isColorized } from './ui.js'

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
  const promptText = isColorized
    ? `${question} ${c.dim(yn)} `
    : `${question} ${yn} `

  const rl = createInterface({ input, output })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(promptText, (a) => resolve(a.trim().toLowerCase()))
    })
    if (answer === '') return defaultYes
    return answer.startsWith('y')
  } finally {
    rl.close()
  }
}

export interface AskTextOptions {
  isTTY?: boolean
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  /** Default returned on non-TTY or empty answer. */
  defaultValue?: string
}

export async function askText(question: string, opts: AskTextOptions = {}): Promise<string> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const isTTY = opts.isTTY ?? (process.stdin as NodeJS.ReadStream).isTTY === true
  const defaultValue = opts.defaultValue ?? ''
  if (!isTTY) return defaultValue

  const rl = createInterface({ input, output })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question + ' ', (a) => resolve(a.trim()))
    })
    return answer || defaultValue
  } finally {
    rl.close()
  }
}

export interface PressEnterOptions {
  isTTY?: boolean
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

/**
 * Pause until the user hits Enter. No-op on non-TTY so the wizard
 * runs unattended in CI / scripted installs.
 */
export async function pressEnter(
  message = 'Press Enter to continue',
  opts: PressEnterOptions = {},
): Promise<void> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const isTTY = opts.isTTY ?? (process.stdin as NodeJS.ReadStream).isTTY === true
  if (!isTTY) return

  const promptText = isColorized ? `${c.dim(message)} ` : `${message} `
  const rl = createInterface({ input, output })
  try {
    await new Promise<void>((resolve) => {
      rl.question(promptText, () => resolve())
    })
  } finally {
    rl.close()
  }
}
