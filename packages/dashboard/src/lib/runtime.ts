/**
 * Runtime-aware CLI command helper.
 *
 * The dashboard is served by either the TS SDK (`@artanis-ai/gravel`)
 * or the Python SDK (`artanis-gravel`). Both ship a `gravel` binary,
 * but the user invokes it through their package manager — `npx
 * @artanis-ai/gravel` and `uvx artanis-gravel` are the universal
 * forms that work without prior project install, matching the
 * one-liners the wizard prints on first run.
 *
 * The SDK injects `window.__GRAVEL_RUNTIME__` ('typescript' | 'python')
 * at shell render time (see handler/shell.ts and _handler.py). The
 * dashboard reads it here to pick the right one-liner for any
 * copy-pasteable command shown in UI copy.
 */

declare global {
  interface Window {
    __GRAVEL_RUNTIME__?: 'typescript' | 'python'
  }
}

export type GravelRuntime = 'typescript' | 'python'

/**
 * Returns the detected SDK runtime. Falls back to 'typescript' when
 * the global isn't set (which only happens in test harnesses that
 * skip the shell-rewriter; production always sets it).
 */
export function gravelRuntime(): GravelRuntime {
  return typeof window !== 'undefined' && window.__GRAVEL_RUNTIME__ === 'python'
    ? 'python'
    : 'typescript'
}

/**
 * Build a one-line CLI invocation appropriate for the current runtime.
 * `args` is the subcommand + flags joined by spaces, e.g.
 * `gravelCommand('manifest --update')`.
 *
 * Returns universal forms (npx / uvx) that work regardless of whether
 * the user added the package as a project dependency — same pattern
 * the wizard's first-run instructions use.
 */
export function gravelCommand(args: string): string {
  const trimmed = args.trim()
  if (gravelRuntime() === 'python') {
    // `uvx artanis-gravel` doesn't auto-resolve because the PyPI
    // package name (`artanis-gravel`) differs from the bin name
    // (`gravel`). Use `--from <pkg> gravel` so uvx fetches the
    // package and runs its `gravel` entrypoint. Surfaced by Olly's
    // de_platform install report — `uvx artanis-gravel ...` was the
    // hint we used to print, and it failed before doing anything.
    return trimmed ? `uvx --from artanis-gravel gravel ${trimmed}` : 'uvx --from artanis-gravel gravel'
  }
  return trimmed ? `npx @artanis-ai/gravel ${trimmed}` : 'npx @artanis-ai/gravel'
}
