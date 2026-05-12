/**
 * Tests for `gravel doctor`. Pins the per-stack upgrade-command
 * matrix so a Python user never sees `pnpm update`, and the human
 * output is stable enough for CI scripts to grep against.
 *
 * `runDoctor` itself does IO (registry fetch + cwd-lockfile probe);
 * we test the pure helpers (`updateCommand`, `renderDoctor`) and let
 * the integration test in `tests/handler-version-route.test.ts` cover
 * the end-to-end shape.
 */
import { describe, it, expect } from 'vitest'
import { renderDoctor, updateCommand, PACKAGE_NAME } from '../src/cli/doctor.js'
import type { VersionInfo } from '../src/handler/version.js'

function info(p: Partial<VersionInfo> = {}): VersionInfo {
  return {
    current: '0.1.0',
    latest: '0.9.9',
    hasUpdate: true,
    packageManager: 'pnpm',
    language: 'ts',
    ...p,
  }
}

describe('updateCommand', () => {
  it('renders pnpm syntax by default', () => {
    expect(updateCommand('pnpm', '1.2.3')).toBe(`pnpm update ${PACKAGE_NAME}@1.2.3`)
  })
  it('renders npm', () => {
    expect(updateCommand('npm', '1.2.3')).toBe(`npm install ${PACKAGE_NAME}@1.2.3`)
  })
  it('renders yarn', () => {
    expect(updateCommand('yarn', '1.2.3')).toBe(`yarn upgrade ${PACKAGE_NAME}@1.2.3`)
  })
  it('renders bun', () => {
    expect(updateCommand('bun', '1.2.3')).toBe(`bun update ${PACKAGE_NAME}@1.2.3`)
  })
  it('renders uv with the Python pkg name when passed explicitly', () => {
    expect(updateCommand('uv', '1.2.3', 'artanis-gravel')).toBe(
      'uv pip install --upgrade artanis-gravel==1.2.3',
    )
  })
  it('renders poetry', () => {
    expect(updateCommand('poetry', '1.2.3', 'artanis-gravel')).toBe(
      'poetry add artanis-gravel@1.2.3',
    )
  })
  it('renders pipenv (which has no per-version-target syntax)', () => {
    expect(updateCommand('pipenv', '1.2.3', 'artanis-gravel')).toBe('pipenv update artanis-gravel')
  })
  it('renders pip', () => {
    expect(updateCommand('pip', '1.2.3', 'artanis-gravel')).toBe(
      'pip install --upgrade artanis-gravel==1.2.3',
    )
  })
})

describe('renderDoctor', () => {
  it('emits the version, stack, and matching upgrade command when an update is available', () => {
    const out = renderDoctor(info({ packageManager: 'pnpm' }))
    expect(out).toMatch(/@artanis-ai\/gravel 0\.1\.0/)
    expect(out).toMatch(/stack: ts \(pnpm\)/)
    expect(out).toMatch(/Update available\./)
    expect(out).toMatch(/pnpm update @artanis-ai\/gravel@0\.9\.9/)
  })

  it('uses the Python package name when language=python', () => {
    const out = renderDoctor(info({ packageManager: 'uv', language: 'python' }))
    expect(out).toMatch(/^artanis-gravel 0\.1\.0/)
    expect(out).toMatch(/stack: python \(uv\)/)
    expect(out).toMatch(/uv pip install --upgrade artanis-gravel==0\.9\.9/)
    expect(out).not.toMatch(/@artanis-ai\/gravel/)
  })

  it('reports "up to date" when hasUpdate is false', () => {
    const out = renderDoctor(info({ hasUpdate: false, latest: '0.1.0' }))
    expect(out).toMatch(/up to date/)
    expect(out).not.toMatch(/Update available/)
  })

  it('reports unknown when registry returned null', () => {
    const out = renderDoctor(info({ latest: null, hasUpdate: false }))
    expect(out).toMatch(/latest: \(unknown/)
    expect(out).not.toMatch(/Update available/)
  })
})
