/**
 * Tab-completion for file paths, used by the manual-entry prompt in
 * the install wizard. Shell-like behaviour: one match → completes the
 * input, multiple matches → readline prints them and lets the user
 * keep typing.
 *
 * Cross-platform: walks the filesystem with `node:fs.readdirSync` and
 * `path.posix`/`path.sep` so Windows back-slashes get normalised. We
 * always return forward-slash paths since that's what the manifest
 * stores. Fail-soft on unreadable directories — a missing folder just
 * means "no matches", not an exception bubbling out of readline.
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type Completer = (line: string) => [string[], string]

/**
 * Build a completer rooted at `repoRoot`. Suggested paths are always
 * relative to that root (the manifest only ever stores relative
 * paths). Absolute inputs are tolerated — they get rebased to
 * relative on completion.
 */
export function pathCompleter(repoRoot: string): Completer {
  return (line: string): [string[], string] => {
    const raw = line.replace(/\\/g, '/').trimStart()
    // Decompose into directory + basename. An empty input means "list
    // the root"; trailing slash means "list the directory's contents".
    const dirRel = raw === '' ? '.' : raw.endsWith('/') ? raw : (dirname(raw) || '.')
    const prefix = raw === '' || raw.endsWith('/') ? '' : basename(raw)
    const dirAbs = isAbsolute(dirRel) ? dirRel : resolve(repoRoot, dirRel)

    let entries: string[]
    try {
      entries = readdirSync(dirAbs)
    } catch {
      return [[], line]
    }

    const matches: string[] = []
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue
      // Skip noise dirs by default — node_modules, .git, etc. aren't
      // where prompts live. The user can type the prefix anyway to
      // force them in.
      if (
        prefix === '' &&
        (name === 'node_modules' ||
          name === '.git' ||
          name === '.next' ||
          name === '.venv' ||
          name === 'dist' ||
          name === 'build')
      ) {
        continue
      }
      const fullAbs = join(dirAbs, name)
      let isDir = false
      try {
        isDir = statSync(fullAbs).isDirectory()
      } catch {
        /* dangling symlink etc — keep, but no slash */
      }
      // Compose the suggestion in the same shape the user typed: keep
      // the leading `dirRel` (so completion preserves what they typed)
      // and append the matched name. Trailing slash for dirs so a
      // second Tab descends into them.
      const head = raw === '' || raw.endsWith('/') ? raw : raw.slice(0, raw.lastIndexOf('/') + 1)
      matches.push(head + name + (isDir ? '/' : ''))
    }
    return [matches.sort(), line]
  }
}

// Test seam — the wizard tests use this to mount a completer at a
// tmpdir without setting process.cwd().
export function pathCompleterFromCwd(): Completer {
  return pathCompleter(process.cwd())
}

// Re-export `relative` so callers can normalise an absolute reply
// back to a repo-relative path.
export function toRepoRelative(repoRoot: string, p: string): string {
  if (!isAbsolute(p)) return p.replace(/\\/g, '/')
  return relative(repoRoot, p).split(sep).join('/')
}
