/**
 * Tiny TUI helpers for the install wizard. Zero deps, ANSI-only, falls
 * back to plain text whenever stdout isn't a TTY (or `NO_COLOR` is set).
 *
 * Design (2026-05-08 v2): the wizard speaks to the user like a teacher
 * walking through a notebook — short paragraphs (`say`), step headings,
 * bullet results, pause-for-enter checkpoints. We dropped the
 * clack-style left rail and the boxed Next-steps panel — both made the
 * install feel like a build log instead of a guided setup.
 *
 * Tests run in non-TTY contexts where every helper degrades to a plain
 * console line — assertions over wizard output keep working.
 */

const HAS_COLOR =
  (process.stdout as NodeJS.WriteStream).isTTY === true && !process.env.NO_COLOR

const HAS_TTY = (process.stdout as NodeJS.WriteStream).isTTY === true

function wrap(open: number | string, close: number): (s: string) => string {
  if (!HAS_COLOR) return (s) => s
  const o = `\x1b[${open}m`
  const c = `\x1b[${close}m`
  return (s) => `${o}${s}${c}`
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  /** Warm sandstone — matches the gravel.artanis.ai landing accent. */
  brand: wrap('38;5;215', 39),
}

const out = process.stdout
function write(s: string): void {
  out.write(s)
}

/** Top-of-wizard greeting. */
export function welcome(title: string, subtitle?: string): void {
  write('\n')
  write(`${c.brand(c.bold(title))}\n`)
  if (subtitle) write(`${c.dim(subtitle)}\n`)
  write('\n')
}

/** A "Step N of M — Title" heading with a divider underneath. */
export function stepHeader(num: number, total: number, title: string): void {
  if (!HAS_COLOR) {
    write(`\nStep ${num} of ${total} — ${title}\n${'─'.repeat(40)}\n\n`)
    return
  }
  const headLine = `${c.brand(`Step ${num} of ${total}`)}  ${c.bold(title)}`
  const divLen = visibleLen(headLine)
  write('\n' + headLine + '\n' + c.dim('─'.repeat(divLen)) + '\n\n')
}

/** A paragraph of conversational text. Wraps naturally on the terminal. */
export function say(text: string): void {
  write(text + '\n\n')
}

/** A subtle aside. */
export function note(text: string): void {
  write(`${c.dim(text)}\n`)
}

export type BulletKind = 'ok' | 'fail' | 'warn' | 'skip' | 'plain' | 'info'

const BULLET_SYMBOL: Record<BulletKind, string> = {
  ok: '✓',
  fail: '✗',
  warn: '▲',
  skip: '·',
  plain: '·',
  info: '·',
}

/** A single-line result under a step. Indented two spaces. */
export function bullet(text: string, kind: BulletKind = 'plain'): void {
  const sym = BULLET_SYMBOL[kind]
  if (!HAS_COLOR) {
    write(`  ${sym} ${text}\n`)
    return
  }
  const colored =
    kind === 'ok'
      ? c.green(sym)
      : kind === 'fail'
        ? c.red(sym)
        : kind === 'warn'
          ? c.yellow(sym)
          : kind === 'skip'
            ? c.dim(sym)
            : kind === 'info'
              ? c.brand(sym)
              : c.dim(sym)
  write(`  ${colored} ${text}\n`)
}

/** Final closing line. */
export function done(text: string): void {
  write(`\n${c.bold(text)}\n\n`)
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface Spinner {
  stop(message?: string): void
  fail(message?: string): void
}

/**
 * Braille spinner that occupies a single line. Indented two spaces to
 * match `bullet()`. Always replaces itself with a ✓ or ✗ on the same
 * line. Falls back to a static "  · message…" line on non-TTY.
 */
export function spinner(initial: string): Spinner {
  if (!HAS_TTY) {
    const trimmed = initial.replace(/…$/, '')
    write(`  · ${trimmed}…\n`)
    return {
      stop(msg = initial) {
        write(`  ✓ ${msg}\n`)
      },
      fail(msg = initial) {
        write(`  ✗ ${msg}\n`)
      },
    }
  }
  let i = 0
  let label = initial
  const render = () => `  ${c.brand(SPINNER_FRAMES[i] ?? '·')} ${label}\x1b[K`
  write(render())
  const id = setInterval(() => {
    i = (i + 1) % SPINNER_FRAMES.length
    write(`\r${render()}`)
  }, 80)
  return {
    stop(msg = label) {
      clearInterval(id)
      label = msg
      write(`\r  ${c.green('✓')} ${msg}\x1b[K\n`)
    },
    fail(msg = label) {
      clearInterval(id)
      label = msg
      write(`\r  ${c.red('✗')} ${c.red(msg)}\x1b[K\n`)
    },
  }
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

/** Whether this run is rendering a live TTY (used by callers to gate prompts). */
export const isInteractiveTTY = HAS_TTY

/** Whether output is colourised (used by tests + the prompt module). */
export const isColorized = HAS_COLOR
