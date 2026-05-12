/**
 * Tests for the pre-commit hook installer. The hook is the *only*
 * thing forcing prompts and the manifest to stay in lockstep — if
 * the installer is broken (clobbers a user's existing hook, double-
 * installs, picks the wrong runner), the manifest silently drifts
 * and the dashboard surfaces stale prompts forever.
 *
 * Covers the three install paths the wizard picks between (Husky →
 * pre-commit framework → native git hook) plus the idempotency check
 * for each.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from '../src/manifest/hook.js'

let repoRoot: string

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'gravel-hook-'))
})
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('installHook — Husky', () => {
  it('appends our line when .husky/pre-commit exists', async () => {
    await mkdir(join(repoRoot, '.husky'), { recursive: true })
    await writeFile(
      join(repoRoot, '.husky', 'pre-commit'),
      '#!/usr/bin/env sh\nnpm test\n',
    )
    const result = await installHook(repoRoot)
    expect(result.mode).toBe('husky')
    expect(result.alreadyInstalled).toBeUndefined()
    const after = await readFile(join(repoRoot, '.husky', 'pre-commit'), 'utf8')
    expect(after).toMatch(/^#!\/usr\/bin\/env sh\nnpm test\ngravel manifest --check/)
  })

  it('is idempotent — second install reports alreadyInstalled and does NOT duplicate the line', async () => {
    await mkdir(join(repoRoot, '.husky'), { recursive: true })
    await writeFile(
      join(repoRoot, '.husky', 'pre-commit'),
      '#!/usr/bin/env sh\ngravel manifest --check\n',
    )
    const result = await installHook(repoRoot)
    expect(result.mode).toBe('husky')
    expect(result.alreadyInstalled).toBe(true)
    const after = await readFile(join(repoRoot, '.husky', 'pre-commit'), 'utf8')
    // Exactly one copy of the line.
    expect(after.match(/manifest --check/g)).toHaveLength(1)
  })
})

describe('installHook — pre-commit framework', () => {
  it('appends a local hook block when .pre-commit-config.yaml exists with repos:', async () => {
    await writeFile(
      join(repoRoot, '.pre-commit-config.yaml'),
      'repos:\n  - repo: https://example.com/some-other-hook\n    hooks:\n      - id: other\n',
    )
    const result = await installHook(repoRoot)
    expect(result.mode).toBe('pre-commit-framework')
    expect(result.alreadyInstalled).toBeUndefined()
    const after = await readFile(join(repoRoot, '.pre-commit-config.yaml'), 'utf8')
    expect(after).toMatch(/id: gravel-manifest/)
    // The user's existing hook block is preserved.
    expect(after).toMatch(/id: other/)
  })

  it('writes a fresh repos: scaffold when the yaml exists but has no repos:', async () => {
    // pre-commit lets you have an empty file as a placeholder.
    await writeFile(join(repoRoot, '.pre-commit-config.yaml'), '# placeholder\n')
    const result = await installHook(repoRoot)
    expect(result.mode).toBe('pre-commit-framework')
    const after = await readFile(join(repoRoot, '.pre-commit-config.yaml'), 'utf8')
    expect(after).toMatch(/^repos:/m)
    expect(after).toMatch(/id: gravel-manifest/)
  })

  it('is idempotent — already-installed yaml is not modified', async () => {
    const existing =
      'repos:\n  - repo: local\n    hooks:\n      - id: gravel-manifest\n        name: x\n        entry: x\n        language: system\n'
    await writeFile(join(repoRoot, '.pre-commit-config.yaml'), existing)
    const result = await installHook(repoRoot)
    expect(result.alreadyInstalled).toBe(true)
    const after = await readFile(join(repoRoot, '.pre-commit-config.yaml'), 'utf8')
    expect(after).toBe(existing)
  })
})

describe('installHook — native .git/hooks/pre-commit', () => {
  it('writes a fresh hook (chmod 0755) when no other hook system is present', async () => {
    await mkdir(join(repoRoot, '.git', 'hooks'), { recursive: true })
    const result = await installHook(repoRoot)
    expect(result.mode).toBe('native')
    expect(result.path).toBe(join(repoRoot, '.git', 'hooks', 'pre-commit'))
    const after = await readFile(result.path!, 'utf8')
    expect(after).toMatch(/^#!\/usr\/bin\/env sh/)
    expect(after).toMatch(/manifest --check/)
    const s = await stat(result.path!)
    // Owner-execute bit set (and chmod 0o755 should set 0o111 mask).
    expect(s.mode & 0o111).not.toBe(0)
  })

  it('appends to an existing native hook instead of overwriting it', async () => {
    await mkdir(join(repoRoot, '.git', 'hooks'), { recursive: true })
    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit')
    await writeFile(hookPath, '#!/usr/bin/env sh\nexisting_user_check\n')
    const result = await installHook(repoRoot)
    expect(result.mode).toBe('native')
    expect(result.alreadyInstalled).toBeUndefined()
    const after = await readFile(hookPath, 'utf8')
    expect(after).toMatch(/existing_user_check/)
    expect(after).toMatch(/manifest --check/)
  })

  it('is idempotent — second run reports alreadyInstalled, no duplicates', async () => {
    await mkdir(join(repoRoot, '.git', 'hooks'), { recursive: true })
    const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit')
    await installHook(repoRoot) // first install
    const before = await readFile(hookPath, 'utf8')
    const result = await installHook(repoRoot) // second install
    expect(result.alreadyInstalled).toBe(true)
    const after = await readFile(hookPath, 'utf8')
    expect(after).toBe(before)
    expect(after.match(/manifest --check/g)).toHaveLength(1)
  })

  it('skips entirely when neither .husky/ nor .pre-commit-config.yaml nor .git/hooks/ exists', async () => {
    const result = await installHook(repoRoot)
    expect(result.mode).toBe('skipped')
    expect(result.path).toBeUndefined()
  })
})

describe('installHook — install priority', () => {
  it('prefers Husky over pre-commit-framework when both are present', async () => {
    await mkdir(join(repoRoot, '.husky'), { recursive: true })
    await writeFile(join(repoRoot, '.husky', 'pre-commit'), '#!/usr/bin/env sh\n')
    await writeFile(join(repoRoot, '.pre-commit-config.yaml'), 'repos:\n')
    const result = await installHook(repoRoot)
    expect(result.mode).toBe('husky')
    // The pre-commit yaml was untouched.
    const yaml = await readFile(join(repoRoot, '.pre-commit-config.yaml'), 'utf8')
    expect(yaml).toBe('repos:\n')
  })

  it('prefers pre-commit-framework over native .git/hooks/ when both are present (no Husky)', async () => {
    await writeFile(join(repoRoot, '.pre-commit-config.yaml'), 'repos:\n')
    await mkdir(join(repoRoot, '.git', 'hooks'), { recursive: true })
    const result = await installHook(repoRoot)
    expect(result.mode).toBe('pre-commit-framework')
    // No native hook was written.
    let nativeExists = false
    try {
      await stat(join(repoRoot, '.git', 'hooks', 'pre-commit'))
      nativeExists = true
    } catch {
      /* expected */
    }
    expect(nativeExists).toBe(false)
  })
})
