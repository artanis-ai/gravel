/**
 * Tiny TUI helpers for the install wizard. Zero deps, ANSI-only, falls
 * back to plain text whenever stdout isn't a TTY (or `NO_COLOR` is set).
 *
 * Layout idiom is clack-style — a left rail of `│` lines threads the
 * sequence of steps, with `◆` marking the active step, `◇` the resolved
 * one, `✓` / `✗` / `▲` for explicit terminal states. A braille spinner
 * stands in for `◆` while a step is doing async work.
 *
 * Tests run in non-TTY contexts where every helper degrades to a plain
 * console.log — assertions over wizard output keep working.
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
  inverse: wrap(7, 27),
}

export const sym = {
  active: '◆',
  done: '◇',
  ok: '✓',
  fail: '✗',
  warn: '▲',
  rail: '│',
  end: '└',
  start: '┌',
}

const out = process.stdout

function write(s: string): void {
  out.write(s)
}

/** Top-of-wizard banner. Drops to a single bold line when colour is off. */
export function header(title: string, subtitle?: string): void {
  if (!HAS_COLOR) {
    write(`${title}${subtitle ? ' — ' + subtitle : ''}\n\n`)
    return
  }
  const pad = '  '
  write('\n')
  write(`${pad}${c.brand(c.bold('▸'))} ${c.bold(title)}`)
  if (subtitle) write(`  ${c.dim(subtitle)}`)
  write('\n')
  write(`${pad}${c.dim('─'.repeat(Math.max(8, title.length + (subtitle?.length ?? 0) + 5)))}\n`)
  write(`${c.dim(sym.rail)}\n`)
}

/** Active step heading — a question or a "starting X" announcement. */
export function step(title: string): void {
  if (!HAS_COLOR) {
    write(`> ${title}\n`)
    return
  }
  write(`${c.brand(sym.active)}  ${c.bold(title)}\n${c.dim(sym.rail)}\n`)
}

/** A line of supporting context under the current rail. */
export function info(text: string): void {
  if (!HAS_COLOR) {
    write(`  ${text}\n`)
    return
  }
  write(`${c.dim(sym.rail)}  ${text}\n${c.dim(sym.rail)}\n`)
}

export function success(text: string): void {
  if (!HAS_COLOR) {
    write(`  ✓ ${text}\n`)
    return
  }
  write(`${c.green(sym.ok)}  ${text}\n${c.dim(sym.rail)}\n`)
}

export function warn(text: string): void {
  if (!HAS_COLOR) {
    write(`  ! ${text}\n`)
    return
  }
  write(`${c.yellow(sym.warn)}  ${c.yellow(text)}\n${c.dim(sym.rail)}\n`)
}

export function failure(text: string): void {
  if (!HAS_COLOR) {
    write(`  x ${text}\n`)
    return
  }
  write(`${c.red(sym.fail)}  ${c.red(text)}\n${c.dim(sym.rail)}\n`)
}

/** Rail-prefixed continuation line (no terminal symbol). */
export function note(text: string): void {
  if (!HAS_COLOR) {
    write(`  ${text}\n`)
    return
  }
  write(`${c.dim(sym.rail)}  ${c.dim(text)}\n`)
}

/** Closing line for the wizard. */
export function done(text: string): void {
  if (!HAS_COLOR) {
    write(`\n${text}\n`)
    return
  }
  write(`${c.brand(sym.end)}  ${c.bold(text)}\n\n`)
}

/**
 * A boxed multi-line callout. Used for the final "Next steps" panel.
 * Lines may contain ANSI codes — width is computed off visible text.
 */
export function panel(title: string, lines: string[]): void {
  if (!HAS_COLOR) {
    write(`\n${title}\n`)
    for (const l of lines) write(`  ${l}\n`)
    write('\n')
    return
  }
  const visibleLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length
  const inner = Math.max(visibleLen(title), ...lines.map(visibleLen))
  const pad = (s: string) => s + ' '.repeat(inner - visibleLen(s))
  const top = c.dim('╭') + c.dim('─'.repeat(inner + 2)) + c.dim('╮')
  const mid = c.dim('├') + c.dim('─'.repeat(inner + 2)) + c.dim('┤')
  const bot = c.dim('╰') + c.dim('─'.repeat(inner + 2)) + c.dim('╯')
  write(`${top}\n`)
  write(`${c.dim('│')} ${c.bold(pad(title))} ${c.dim('│')}\n`)
  write(`${mid}\n`)
  for (const l of lines) write(`${c.dim('│')} ${pad(l)} ${c.dim('│')}\n`)
  write(`${bot}\n\n`)
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface Spinner {
  stop(message?: string): void
  fail(message?: string): void
}

/**
 * Braille spinner that occupies a single line under the rail. Falls back
 * to a static "… message" line when stdout isn't a TTY. Always stops with
 * a ✓ or ✗ on the same line.
 */
export function spinner(initial: string): Spinner {
  if (!HAS_TTY) {
    const trimmed = initial.replace(/…$/, '')
    write(`  ${trimmed}…\n`)
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
  const render = () =>
    `${c.brand(SPINNER_FRAMES[i] ?? '·')}  ${label}\x1b[K`
  write(render())
  const id = setInterval(() => {
    i = (i + 1) % SPINNER_FRAMES.length
    write(`\r${render()}`)
  }, 80)
  return {
    stop(msg = label) {
      clearInterval(id)
      label = msg
      write(`\r${c.green(sym.ok)}  ${msg}\x1b[K\n${c.dim(sym.rail)}\n`)
    },
    fail(msg = label) {
      clearInterval(id)
      label = msg
      write(`\r${c.red(sym.fail)}  ${c.red(msg)}\x1b[K\n${c.dim(sym.rail)}\n`)
    },
  }
}

/**
 * Render the user's resolved answer to a confirm() prompt. Replaces the
 * preceding question line with a dim summary so the rail stays uncluttered.
 */
export function rewriteAnswer(question: string, answer: string): void {
  if (!HAS_COLOR) {
    write(`  -> ${answer}\n`)
    return
  }
  // Cursor up two (rail line + question line), clear both, redraw.
  write('\x1b[2A\r\x1b[J')
  write(`${c.dim(sym.done)}  ${c.dim(question)} ${c.dim('—')} ${c.dim(answer)}\n${c.dim(sym.rail)}\n`)
}

/** Whether this run is rendering a live TTY (used by callers to gate prompts). */
export const isInteractiveTTY = HAS_TTY
