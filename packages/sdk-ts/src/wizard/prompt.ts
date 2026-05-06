/**
 * Tiny stdin prompt helper. Used by the wizard for interactive choices.
 * Returns the trimmed answer, or `null` if stdin is not a TTY (so callers
 * can fall back to a non-interactive default).
 */
import { createInterface } from 'node:readline'

export interface PromptOptions {
  /** Override TTY detection (test injection). */
  isTTY?: boolean
  /** Override stdin (test injection). */
  input?: NodeJS.ReadableStream
  /** Override stdout (test injection). */
  output?: NodeJS.WritableStream
}

export async function ask(question: string, opts: PromptOptions = {}): Promise<string | null> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const isTTY = opts.isTTY ?? (process.stdin as NodeJS.ReadStream).isTTY === true
  if (!isTTY) return null

  const rl = createInterface({ input, output })
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()))
    })
  } finally {
    rl.close()
  }
}

/**
 * Prompts for a single-letter choice from a fixed set, with a default.
 * Returns the lowercased letter, or the default if the user just hit Enter
 * or stdin is not a TTY.
 */
export async function askChoice(
  question: string,
  choices: string[],
  defaultChoice: string,
  opts: PromptOptions = {},
): Promise<string> {
  const answer = await ask(question, opts)
  if (answer === null || answer.length === 0) return defaultChoice
  const letter = answer[0]!.toLowerCase()
  return choices.includes(letter) ? letter : defaultChoice
}
