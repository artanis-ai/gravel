import { afterEach, describe, expect, it, beforeEach } from 'vitest'
import { gravelCommand, gravelRuntime } from './runtime'

describe('gravelRuntime', () => {
  const originalRuntime = window.__GRAVEL_RUNTIME__
  afterEach(() => {
    window.__GRAVEL_RUNTIME__ = originalRuntime
  })

  it('defaults to typescript when global is unset', () => {
    delete window.__GRAVEL_RUNTIME__
    expect(gravelRuntime()).toBe('typescript')
  })

  it('reports python when SDK injected it', () => {
    window.__GRAVEL_RUNTIME__ = 'python'
    expect(gravelRuntime()).toBe('python')
  })

  it('reports typescript when SDK injected it', () => {
    window.__GRAVEL_RUNTIME__ = 'typescript'
    expect(gravelRuntime()).toBe('typescript')
  })
})

describe('gravelCommand', () => {
  const originalRuntime = window.__GRAVEL_RUNTIME__
  beforeEach(() => {
    delete window.__GRAVEL_RUNTIME__
  })
  afterEach(() => {
    window.__GRAVEL_RUNTIME__ = originalRuntime
  })

  it('emits the npx one-liner for typescript', () => {
    window.__GRAVEL_RUNTIME__ = 'typescript'
    expect(gravelCommand('manifest --update')).toBe(
      'npx @artanis-ai/gravel manifest --update',
    )
  })

  it('emits the uvx one-liner for python', () => {
    window.__GRAVEL_RUNTIME__ = 'python'
    expect(gravelCommand('manifest --update')).toBe(
      'uvx artanis-gravel manifest --update',
    )
  })

  it('matches the wizard-published install one-liner shape', () => {
    // Same shape Yousef used to install — universal, no project install required.
    window.__GRAVEL_RUNTIME__ = 'python'
    expect(gravelCommand('init')).toBe('uvx artanis-gravel init')
    window.__GRAVEL_RUNTIME__ = 'typescript'
    expect(gravelCommand('init')).toBe('npx @artanis-ai/gravel init')
  })

  it('handles empty args', () => {
    window.__GRAVEL_RUNTIME__ = 'typescript'
    expect(gravelCommand('')).toBe('npx @artanis-ai/gravel')
    window.__GRAVEL_RUNTIME__ = 'python'
    expect(gravelCommand('   ')).toBe('uvx artanis-gravel')
  })
})
