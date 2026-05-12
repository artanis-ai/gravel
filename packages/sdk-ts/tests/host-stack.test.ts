/**
 * Tests for the runtime host-stack detector. Pins the precedence the
 * UpdateBanner + `gravel doctor` rely on so a user with a pnpm
 * lockfile doesn't get told to run `npm install`, and Python
 * customers don't get JS-shaped commands.
 *
 * The detector reads a few well-known lockfile paths from a given cwd;
 * tests spin up a tmpdir per case + touch the relevant file.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetHostStackCacheForTests,
  detectHostStack,
} from '../src/handler/host-stack.js'

async function sandbox(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gravel-host-stack-'))
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
  return dir
}

beforeEach(() => _resetHostStackCacheForTests())

describe('detectHostStack — TypeScript hosts', () => {
  it('picks pnpm when pnpm-lock.yaml is present', async () => {
    const dir = await sandbox({ 'pnpm-lock.yaml': '' })
    expect(await detectHostStack(dir)).toEqual({ language: 'ts', packageManager: 'pnpm' })
  })
  it('picks yarn when yarn.lock is present (no pnpm)', async () => {
    const dir = await sandbox({ 'yarn.lock': '' })
    expect(await detectHostStack(dir)).toEqual({ language: 'ts', packageManager: 'yarn' })
  })
  it('picks bun for either bun.lock or bun.lockb', async () => {
    const a = await sandbox({ 'bun.lock': '' })
    const b = await sandbox({ 'bun.lockb': '' })
    expect(await detectHostStack(a)).toEqual({ language: 'ts', packageManager: 'bun' })
    _resetHostStackCacheForTests()
    expect(await detectHostStack(b)).toEqual({ language: 'ts', packageManager: 'bun' })
  })
  it('falls back to npm for package.json without a lockfile', async () => {
    const dir = await sandbox({ 'package.json': '{}' })
    expect(await detectHostStack(dir)).toEqual({ language: 'ts', packageManager: 'npm' })
  })
  it('falls back to npm when no lockfile and no python markers are present', async () => {
    const dir = await sandbox({})
    expect(await detectHostStack(dir)).toEqual({ language: 'ts', packageManager: 'npm' })
  })
  it('prefers pnpm even if a stray package-lock.json is also there', async () => {
    const dir = await sandbox({ 'pnpm-lock.yaml': '', 'package-lock.json': '' })
    expect(await detectHostStack(dir)).toEqual({ language: 'ts', packageManager: 'pnpm' })
  })
})

describe('detectHostStack — Python hosts', () => {
  it('picks uv when uv.lock is present', async () => {
    const dir = await sandbox({ 'uv.lock': '' })
    expect(await detectHostStack(dir)).toEqual({ language: 'python', packageManager: 'uv' })
  })
  it('picks poetry when poetry.lock is present', async () => {
    const dir = await sandbox({ 'poetry.lock': '' })
    expect(await detectHostStack(dir)).toEqual({ language: 'python', packageManager: 'poetry' })
  })
  it('picks pipenv when Pipfile.lock is present', async () => {
    const dir = await sandbox({ 'Pipfile.lock': '' })
    expect(await detectHostStack(dir)).toEqual({ language: 'python', packageManager: 'pipenv' })
  })
  it('falls back to pip for pyproject.toml with no Python lockfile', async () => {
    const dir = await sandbox({ 'pyproject.toml': '' })
    expect(await detectHostStack(dir)).toEqual({ language: 'python', packageManager: 'pip' })
  })
  it('falls back to pip for requirements.txt', async () => {
    const dir = await sandbox({ 'requirements.txt': '' })
    expect(await detectHostStack(dir)).toEqual({ language: 'python', packageManager: 'pip' })
  })
  it('python lockfile wins over a stray package.json (Python-primary host)', async () => {
    const dir = await sandbox({ 'uv.lock': '', 'package.json': '{}' })
    expect(await detectHostStack(dir)).toEqual({ language: 'python', packageManager: 'uv' })
  })
  it('falls back to TS when pyproject.toml AND package.json both exist (TS-primary, e.g. tooling repo)', async () => {
    const dir = await sandbox({ 'pyproject.toml': '', 'package.json': '{}' })
    // The pyproject-without-lockfile heuristic only fires when
    // package.json is absent — guards against tooling repos that happen
    // to ship a pyproject for linting but are JS-primary.
    expect(await detectHostStack(dir)).toEqual({ language: 'ts', packageManager: 'npm' })
  })
})

describe('detectHostStack — caching', () => {
  it('returns the same result for repeat calls on the same cwd', async () => {
    const dir = await sandbox({ 'pnpm-lock.yaml': '' })
    const a = await detectHostStack(dir)
    const b = await detectHostStack(dir)
    expect(a).toBe(b)
  })
  it('re-detects when cwd changes', async () => {
    const a = await sandbox({ 'pnpm-lock.yaml': '' })
    const b = await sandbox({ 'yarn.lock': '' })
    expect((await detectHostStack(a)).packageManager).toBe('pnpm')
    expect((await detectHostStack(b)).packageManager).toBe('yarn')
  })
})
