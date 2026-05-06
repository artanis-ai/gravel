/**
 * Tests for the home-grown token-level diff.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { diffStrings, DiffView } from './DiffView'

describe('diffStrings', () => {
  it('returns a single keep segment when nothing changed', () => {
    const segs = diffStrings('hello world', 'hello world')
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual({ op: 'keep', text: 'hello world' })
  })

  it('marks added words as inserts and removed words as removes', () => {
    const segs = diffStrings('the quick fox', 'the slow fox')
    // Possible segmentation: keep("the "), remove("quick"), insert("slow"), keep(" fox")
    const ops = segs.map((s) => s.op)
    expect(ops).toContain('insert')
    expect(ops).toContain('remove')
    expect(ops).toContain('keep')
    // Reconstructing the "after" side from keep + insert recovers the input.
    const after = segs
      .filter((s) => s.op !== 'remove')
      .map((s) => s.text)
      .join('')
    expect(after).toBe('the slow fox')
    const before = segs
      .filter((s) => s.op !== 'insert')
      .map((s) => s.text)
      .join('')
    expect(before).toBe('the quick fox')
  })

  it('handles pure insertion', () => {
    const segs = diffStrings('hi', 'hi friend')
    expect(segs[0]).toEqual({ op: 'keep', text: 'hi' })
    expect(segs.some((s) => s.op === 'insert' && s.text.includes('friend'))).toBe(true)
  })

  it('handles pure deletion', () => {
    const segs = diffStrings('hello world', 'hello')
    expect(segs.some((s) => s.op === 'remove' && s.text.includes('world'))).toBe(true)
  })
})

describe('DiffView', () => {
  it('matches the snapshot for a known string pair', () => {
    const { container } = render(
      <DiffView before="You are a helpful assistant." after="You are an honest assistant." />,
    )
    expect(container.innerHTML).toMatchSnapshot()
  })
})
