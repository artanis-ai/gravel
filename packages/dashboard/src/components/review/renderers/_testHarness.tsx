/**
 * Test harness: renders a Renderer's `{input, output}` pair into a
 * single DOM tree so existing `container.textContent` assertions
 * keep working after the API moved from `ReactNode` to
 * `{input, output}`.
 *
 * Real production layout puts these in side-by-side panes — see
 * `ReviewSurface`. The harness flattens them with visible markers
 * (`__INPUT_PANE_START__` / `__OUTPUT_PANE_START__`) so tests
 * can scope assertions to a specific pane when needed.
 */
import type { ReactNode } from 'react'
import type { Renderer, RendererProps } from '../types'

export function RenderBoth({
  renderer,
  ...props
}: { renderer: Renderer } & RendererProps): ReactNode {
  const { input, output } = renderer(props)
  return (
    <div>
      <div data-pane="input">{input}</div>
      <div data-pane="output">{output}</div>
    </div>
  )
}
