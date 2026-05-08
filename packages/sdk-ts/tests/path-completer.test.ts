/**
 * Unit tests for the manual-entry path completer.
 *
 * Sanity-checks shell-like completion behaviour (prefix match, dir
 * trailing-slash, fail-soft on missing dirs) against a real tmp tree.
 * Cross-platform — uses node:fs everywhere; the only OS-specific
 * concern is path separators on input, which we normalise to `/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathCompleter, toRepoRelative } from '../src/wizard/path-completer.js'

let workdir: string

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'gravel-completer-'))
  await fs.mkdir(join(workdir, 'src', 'agents'), { recursive: true })
  await fs.mkdir(join(workdir, 'src', 'shared'), { recursive: true })
  await fs.mkdir(join(workdir, 'prompts'), { recursive: true })
  await fs.writeFile(join(workdir, 'src', 'agents', 'triage.ts'), '')
  await fs.writeFile(join(workdir, 'src', 'agents', 'translator.ts'), '')
  await fs.writeFile(join(workdir, 'src', 'index.ts'), '')
  await fs.writeFile(join(workdir, 'prompts', 'system.md'), '')
  await fs.writeFile(join(workdir, 'package.json'), '{}')
  // Noise dirs that should be hidden when the prefix is empty.
  await fs.mkdir(join(workdir, 'node_modules'), { recursive: true })
  await fs.mkdir(join(workdir, 'dist'), { recursive: true })
})
afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true })
})

describe('pathCompleter', () => {
  it('lists the repo root with empty input, hiding noise dirs', () => {
    const c = pathCompleter(workdir)
    const [matches] = c('')
    expect(matches).toContain('src/')
    expect(matches).toContain('prompts/')
    expect(matches).toContain('package.json')
    expect(matches).not.toContain('node_modules/')
    expect(matches).not.toContain('dist/')
  })

  it('completes a partial top-level prefix', () => {
    const c = pathCompleter(workdir)
    const [matches] = c('pro')
    expect(matches).toEqual(['prompts/'])
  })

  it('descends after a trailing slash', () => {
    const c = pathCompleter(workdir)
    const [matches] = c('src/')
    expect(matches).toEqual(expect.arrayContaining(['src/agents/', 'src/shared/', 'src/index.ts']))
  })

  it('completes a partial nested name', () => {
    const c = pathCompleter(workdir)
    const [matches] = c('src/agents/tr')
    expect(matches).toEqual(expect.arrayContaining(['src/agents/triage.ts', 'src/agents/translator.ts']))
    // Order is alphabetical so editor users see consistent output.
    expect(matches[0]).toBe('src/agents/translator.ts')
    expect(matches[1]).toBe('src/agents/triage.ts')
  })

  it('returns no matches for a directory that does not exist', () => {
    const c = pathCompleter(workdir)
    const [matches] = c('nope/')
    expect(matches).toEqual([])
  })

  it('does not suggest noise dirs even when the prefix matches them', () => {
    const c = pathCompleter(workdir)
    // Empty prefix → noise hidden.
    const [emptyMatches] = c('')
    expect(emptyMatches).not.toContain('node_modules/')
    // Explicit prefix → user opt-in, surface them.
    const [explicitMatches] = c('node_')
    expect(explicitMatches).toContain('node_modules/')
  })

  it('handles backslashes in input (Windows users may type them)', () => {
    const c = pathCompleter(workdir)
    const [matches] = c('src\\agents\\')
    expect(matches).toEqual(expect.arrayContaining(['src/agents/triage.ts', 'src/agents/translator.ts']))
  })
})

describe('toRepoRelative', () => {
  it('passes a relative path through, normalised to forward slashes', () => {
    expect(toRepoRelative('/repo', 'src\\foo.ts')).toBe('src/foo.ts')
  })

  it('rebases an absolute path against the repo root', () => {
    expect(toRepoRelative('/repo', '/repo/src/foo.ts')).toBe('src/foo.ts')
  })
})
