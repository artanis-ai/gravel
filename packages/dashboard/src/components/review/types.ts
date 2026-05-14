/**
 * Renderer contract shared by every per-source renderer.
 *
 * Renderers split their output into two panes — `input` (request
 * side, left) and `output` (response side, right). The
 * ReviewSurface lays them out side by side, matching the
 * dashboard's long-standing Input/Output convention. A renderer
 * that has nothing to put in one pane returns `null` for it.
 *
 * Renderers must:
 *   1. Surface the conversation/operation in a human-readable way
 *      (chat messages, embeddings request, chain inputs, etc.).
 *   2. Delegate anything they don't recognise to `HumanValue` so no
 *      payload field is silently dropped.
 *   3. NOT render token usage (the surrounding ReviewSurface shows
 *      it) or metadata (same) or fetch URL chrome (same).
 *
 * Each renderer ALSO owns its own snapshot test
 * (`<source>.test.tsx`) that loads every fixture from
 * `tests/fixtures/sources/` declaring that source. Renderers must
 * be pure (no remote fetches, no localStorage, no time-dependent
 * formatting) so the snapshots are stable.
 */
import type { ReactNode } from 'react'

export interface RendererProps {
  /** The unwrapped provider input — `body` for fetch samples,
   *  `gravel_samples.input` otherwise. */
  input: unknown
  /** The unwrapped provider output. Null when the call errored
   *  before a response could be parsed. */
  output: unknown
  /** Whether the original trace name had a `fetch:` prefix.
   *  Renderers don't need to react to this themselves (the
   *  ReviewSurface shows the FetchHeader); pass-through for
   *  the rare renderer that wants to vary by SDK vs raw HTTP. */
  isFetch: boolean
}

export interface RendererResult {
  /** Left pane content. The request-side view. Null if the
   *  renderer has nothing to show in this pane. */
  input: ReactNode
  /** Right pane content. The response-side view. Null if the
   *  renderer has nothing to show in this pane. */
  output: ReactNode
}

export type Renderer = (props: RendererProps) => RendererResult
