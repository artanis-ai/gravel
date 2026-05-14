/**
 * StreamObservations: shows the chunk count + throughput. The raw
 * chunk list lives behind a <details> disclosure.
 */
import { cleanup, render, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { StreamObservations } from './StreamObservations'

afterEach(() => cleanup())

describe('StreamObservations', () => {
  it('renders nothing without chunks', () => {
    const { container } = render(<StreamObservations metadata={null} />)
    expect(container.textContent).toBe('')
  })

  it('renders nothing when metadata.states is empty', () => {
    const { container } = render(<StreamObservations metadata={{ states: [] }} />)
    expect(container.textContent).toBe('')
  })

  it('summarises a streamed call: chunk count + throughput', () => {
    const states = [
      { type: 'chunk', ts: 1000, delta: 'A' },
      { type: 'chunk', ts: 1100, delta: 'B' },
      { type: 'chunk', ts: 1300, delta: 'C' },
      { type: 'finish', ts: 1500, finish_reason: 'stop' },
    ]
    const { container } = render(<StreamObservations metadata={{ states }} />)
    expect(container.textContent).toMatch(/4 chunks/)
    // (4 chunks / 0.5s) = 8.0/s
    expect(container.textContent).toMatch(/8\.0\/s/)
  })

  it('accepts the legacy `observations` key as a fallback', () => {
    const obs = [
      { type: 'chunk', ts: 0 },
      { type: 'chunk', ts: 100 },
    ]
    const { container } = render(<StreamObservations metadata={{ observations: obs }} />)
    expect(container.textContent).toMatch(/2 chunks/)
  })

  it('expanding the disclosure shows the chunk list', () => {
    const states = [
      { type: 'chunk', ts: 0, delta: 'hello' },
      { type: 'chunk', ts: 50, delta: 'world' },
    ]
    const { container } = render(<StreamObservations metadata={{ states }} />)
    const summary = container.querySelector('summary')!
    fireEvent.click(summary)
    expect(container.textContent).toContain('hello')
    expect(container.textContent).toContain('world')
  })
})
