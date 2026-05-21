/**
 * Tests for HumanValue's long-list collapse + show-more behaviour.
 *
 * Bug class this pins: structured-output enums (e.g. `enum: ['a', 'b',
 * ..., 200 values]`) dumped the entire list into the review pane,
 * pushing everything else offscreen. v0.9.x adds `ExpandableList`:
 * shows the first N items + a "show more" link, parallels
 * `ExpandableString` for long strings.
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { HumanValue } from './HumanValue'

describe('HumanValue: long-list collapse', () => {
  it('renders all items when the list is short', () => {
    render(<HumanValue value={['a', 'b', 'c', 'd', 'e']} />)
    for (const c of ['a', 'b', 'c', 'd', 'e']) {
      expect(screen.getByText(c)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('expandable-list-toggle')).not.toBeInTheDocument()
  })

  it('collapses past the threshold and surfaces a show-more toggle', () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`)
    render(<HumanValue value={items} />)
    // First 6 items visible (LONG_LIST_PREVIEW).
    for (let i = 0; i < 6; i++) {
      expect(screen.getByText(`item-${i}`)).toBeInTheDocument()
    }
    // Items past the preview are NOT in the DOM yet.
    expect(screen.queryByText('item-6')).not.toBeInTheDocument()
    expect(screen.queryByText('item-19')).not.toBeInTheDocument()
    const toggle = screen.getByTestId('expandable-list-toggle')
    expect(toggle).toHaveTextContent('show 14 more (20 total)')
  })

  it('expands all items when the toggle is clicked, then collapses back', () => {
    const items = Array.from({ length: 25 }, (_, i) => `v${i}`)
    render(<HumanValue value={items} />)
    fireEvent.click(screen.getByTestId('expandable-list-toggle'))
    // Every item is now visible.
    for (let i = 0; i < 25; i++) {
      expect(screen.getByText(`v${i}`)).toBeInTheDocument()
    }
    // Toggle now reads "show less".
    const toggle = screen.getByTestId('expandable-list-toggle')
    expect(toggle).toHaveTextContent('show less')
    // Click again to collapse.
    fireEvent.click(toggle)
    expect(screen.queryByText('v24')).not.toBeInTheDocument()
    expect(screen.getByText('v0')).toBeInTheDocument()
  })

  it('does not collapse object-array tables (those go through HumanTable)', () => {
    // Arrays of objects with overlapping keys render as a table, not a
    // bullet list; the collapse path only fires for the list shape.
    const items = Array.from({ length: 20 }, (_, i) => ({ k: `v${i}`, n: i }))
    render(<HumanValue value={items} />)
    expect(screen.queryByTestId('expandable-list-toggle')).not.toBeInTheDocument()
  })

  it('honours the exact threshold (12 items renders all, 13 collapses)', () => {
    const exact = Array.from({ length: 12 }, (_, i) => `t${i}`)
    const { unmount } = render(<HumanValue value={exact} />)
    expect(screen.queryByTestId('expandable-list-toggle')).not.toBeInTheDocument()
    unmount()

    const over = Array.from({ length: 13 }, (_, i) => `o${i}`)
    render(<HumanValue value={over} />)
    expect(screen.getByTestId('expandable-list-toggle')).toBeInTheDocument()
  })
})
