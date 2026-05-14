/**
 * TraceNavigator: dumb step strip. Tests focus on
 *   - Steps sorted by `started_at`.
 *   - Active step highlighted.
 *   - Current sample slotted in if missing from `related`.
 *   - onJump fires with the right id when a sibling is clicked.
 *   - Returns null when there's only one (or zero) steps.
 */
import { cleanup, render, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TraceNavigator } from './TraceNavigator'

afterEach(() => cleanup())

describe('TraceNavigator', () => {
  it('renders nothing when there is only one step', () => {
    const { container } = render(
      <TraceNavigator
        related={[]}
        currentSampleId="a"
        currentPreview="alone"
        currentStartedAt="2026-05-13T00:00:00Z"
        onJump={() => {}}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('renders ordered steps and highlights the active one', () => {
    const related = [
      { id: 'c', preview: 'step-3', started_at: '2026-05-13T00:00:02Z' },
      { id: 'a', preview: 'step-1', started_at: '2026-05-13T00:00:00Z' },
    ]
    const { container } = render(
      <TraceNavigator
        related={related}
        currentSampleId="b"
        currentPreview="step-2"
        currentStartedAt="2026-05-13T00:00:01Z"
        onJump={() => {}}
      />,
    )
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(3)
    // Sort order: a, b, c (by started_at)
    expect(buttons[0]!.textContent).toContain('step-1')
    expect(buttons[1]!.textContent).toContain('step-2')
    expect(buttons[2]!.textContent).toContain('step-3')
    // The middle one is active.
    expect(buttons[1]!.getAttribute('aria-current')).toBe('step')
  })

  it('fires onJump with the clicked sibling id', () => {
    const related = [
      { id: 'a', preview: 'first', started_at: '2026-05-13T00:00:00Z' },
      { id: 'c', preview: 'third', started_at: '2026-05-13T00:00:02Z' },
    ]
    const onJump = vi.fn()
    const { container } = render(
      <TraceNavigator
        related={related}
        currentSampleId="b"
        currentPreview="second"
        currentStartedAt="2026-05-13T00:00:01Z"
        onJump={onJump}
      />,
    )
    const buttons = container.querySelectorAll('button')
    // Click step 3 (last).
    fireEvent.click(buttons[2]!)
    expect(onJump).toHaveBeenCalledWith('c')
  })

  it('shows the trace counter (active / total)', () => {
    const related = [
      { id: 'a', preview: 'A', started_at: '2026-05-13T00:00:00Z' },
      { id: 'c', preview: 'C', started_at: '2026-05-13T00:00:02Z' },
    ]
    const { container } = render(
      <TraceNavigator
        related={related}
        currentSampleId="a"
        onJump={() => {}}
      />,
    )
    expect(container.textContent).toMatch(/1 \/ 2/)
  })
})
