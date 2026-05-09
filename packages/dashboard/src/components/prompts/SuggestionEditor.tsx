/**
 * SuggestionEditor — a single-pane prompt editor that renders the
 * draft as Google-Docs-style "suggestions" against the original:
 *
 *   - Insertions show with a green underline + tinted background where
 *     the new text sits in the editor doc.
 *   - Deletions appear as inline strikethrough widgets at the position
 *     where the user removed text. The widget text is the slice that
 *     was cut, so the reviewer can see what changed without flipping
 *     between two panes.
 *
 * The editor doc holds the *current draft text* (so typing, undo, and
 * cursor behaviour are normal CodeMirror); diffs are computed against
 * the original on every change and re-applied as decorations.
 *
 * The "Reset" affordance is the parent's responsibility — we just emit
 * onChange with the raw draft text. Same for save / discard.
 */
import { useEffect, useRef } from 'react'
import { EditorView, keymap, Decoration, type DecorationSet, WidgetType } from '@codemirror/view'
import { EditorState, StateField, StateEffect, type Extension } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { diffChars, type Change } from 'diff'

interface DiffDecorations {
  decorations: DecorationSet
  /** Total inserted-char count, for the "n suggestions" badge in the header. */
  insertions: number
  /** Total deleted-char count. */
  deletions: number
}

const setDiffEffect = StateEffect.define<DiffDecorations>()

const diffField = StateField.define<DiffDecorations>({
  create: () => ({ decorations: Decoration.none, insertions: 0, deletions: 0 }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDiffEffect)) return e.value
    return tr.docChanged
      ? { ...value, decorations: value.decorations.map(tr.changes) }
      : value
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
})

class DeletionWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-suggestion-deletion'
    // Show whitespace-only deletions as visible markers so a reviewer
    // can see e.g. "newline removed" instead of an invisible strike.
    el.textContent = this.text.replace(/\n/g, '↵\n').replace(/\t/g, '→')
    return el
  }
  eq(other: WidgetType): boolean {
    return other instanceof DeletionWidget && other.text === this.text
  }
  // Allow caret to land before the widget normally.
  ignoreEvent(): boolean {
    return false
  }
}

/** Char-level insertion / deletion totals — used by the parent for the "+12 −3" badge. */
export function computeDiffStats(original: string, current: string): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  for (const change of diffChars(original, current)) {
    if (change.added) insertions += change.value.length
    else if (change.removed) deletions += change.value.length
  }
  return { insertions, deletions }
}

/** Build CodeMirror decorations from a char-level diff. */
function buildDiff(original: string, current: string): DiffDecorations {
  const changes: Change[] = diffChars(original, current)
  const decorations: { from: number; spec: Decoration }[] = []
  let pos = 0 // position in `current`
  let insertions = 0
  let deletions = 0
  for (const change of changes) {
    if (change.added) {
      const from = pos
      const to = pos + change.value.length
      decorations.push({
        from,
        spec: Decoration.mark({ class: 'cm-suggestion-insertion' }).range(from, to) as never,
      })
      pos = to
      insertions += change.value.length
    } else if (change.removed) {
      // Deletion happens at `pos` in the current doc — render the
      // removed slice as an inline widget. side: -1 keeps it visually
      // anchored before any insertion at the same spot.
      const widget = Decoration.widget({
        widget: new DeletionWidget(change.value),
        side: -1,
      }).range(pos)
      decorations.push({ from: pos, spec: widget as never })
      deletions += change.value.length
    } else {
      pos += change.value.length
    }
  }
  decorations.sort((a, b) => a.from - b.from)
  return {
    decorations: Decoration.set(decorations.map((d) => d.spec) as never),
    insertions,
    deletions,
  }
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    padding: '14px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
    lineHeight: '1.55',
  },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-suggestion-insertion': {
    backgroundColor: 'rgba(74, 124, 89, 0.15)',
    color: '#2f5b3a',
    textDecoration: 'underline',
    textDecorationColor: '#4A7C59',
    textDecorationThickness: '1px',
  },
  '.cm-suggestion-deletion': {
    color: '#9B4340',
    backgroundColor: 'rgba(155, 67, 64, 0.08)',
    textDecoration: 'line-through',
    textDecorationColor: '#9B4340',
    padding: '0 1px',
    borderRadius: '2px',
    whiteSpace: 'pre-wrap',
    fontStyle: 'italic',
  },
})

export interface SuggestionEditorProps {
  /** The unedited prompt body (server truth). Diffs anchor against this. */
  original: string
  /** Current draft text. The parent controls this so it can persist drafts. */
  value: string
  onChange: (next: string) => void
  /** Surfaces the live diff stats so the parent can show "+12 / −3". */
  onDiffStats?: (stats: { insertions: number; deletions: number }) => void
  /** Optional aria-label override; default "Prompt draft". */
  ariaLabel?: string
}

export function SuggestionEditor({
  original,
  value,
  onChange,
  onDiffStats,
  ariaLabel = 'Prompt draft',
}: SuggestionEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Latest callbacks live in refs so the editor effect doesn't have to
  // re-mount on every render (mounting CodeMirror eats the user's cursor).
  const onChangeRef = useRef(onChange)
  const onDiffStatsRef = useRef(onDiffStats)
  const originalRef = useRef(original)
  onChangeRef.current = onChange
  onDiffStatsRef.current = onDiffStats
  originalRef.current = original

  // Mount the editor exactly once. The doc is initialised with `value`
  // at mount time; further parent-driven `value` changes are pushed in
  // via the second effect below.
  useEffect(() => {
    if (!containerRef.current) return
    const initial = value
    const extensions: Extension[] = [
      keymap.of([...defaultKeymap, ...historyKeymap]),
      history(),
      markdown(),
      editorTheme,
      diffField,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const next = update.state.doc.toString()
        onChangeRef.current(next)
        const diff = buildDiff(originalRef.current, next)
        update.view.dispatch({ effects: setDiffEffect.of(diff) })
        onDiffStatsRef.current?.({ insertions: diff.insertions, deletions: diff.deletions })
      }),
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: initial, extensions }),
      parent: containerRef.current,
    })
    viewRef.current = view
    // Seed initial diff so insertions in an existing draft show on mount.
    const seeded = buildDiff(originalRef.current, initial)
    view.dispatch({ effects: setDiffEffect.of(seeded) })
    onDiffStatsRef.current?.({ insertions: seeded.insertions, deletions: seeded.deletions })
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push parent-driven value changes (e.g. "Reset" sets value back to
  // original) into the doc. Skip when the new value already matches the
  // editor — this is the common case during typing and a redundant
  // dispatch would clobber the cursor.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    })
  }, [value])

  // Re-diff when the original itself changes (e.g. the prompt was
  // re-fetched from a different revision). This dispatches a new diff
  // effect against the existing doc.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const next = view.state.doc.toString()
    const diff = buildDiff(original, next)
    view.dispatch({ effects: setDiffEffect.of(diff) })
    onDiffStatsRef.current?.({ insertions: diff.insertions, deletions: diff.deletions })
  }, [original])

  return (
    <div
      ref={containerRef}
      role="textbox"
      aria-label={ariaLabel}
      aria-multiline="true"
      className="h-full cursor-text overflow-hidden rounded-xl border border-warm bg-white"
      onClick={() => viewRef.current?.focus()}
      data-testid="suggestion-editor"
    />
  )
}
