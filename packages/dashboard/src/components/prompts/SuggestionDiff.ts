/**
 * SuggestionDiff — Tiptap/ProseMirror extension that overlays a
 * Google-Docs-style "suggestions" diff onto the live document:
 *
 *   - Inserted runs get a green underline + tinted background where
 *     the new text sits.
 *   - Deleted runs render as inline strikethrough widgets at the
 *     position they were cut from, so the reviewer sees what changed
 *     without flipping panes.
 *
 * The doc itself stays clean — these are ProseMirror decorations, not
 * marks or nodes, so the markdown round-trip is unaffected. Updates
 * are recomputed from a word-level diff between the doc's text
 * content and the original prompt's text content.
 *
 * Caveat: this works on text content. A purely structural change
 * (e.g. wrapping the same words in bold) doesn't show as a diff
 * because the textContent is identical. Word-level prose edits — the
 * common case for prompt iteration — show correctly.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PmNode } from '@tiptap/pm/model'
import { diffWordsWithSpace } from 'diff'

const pluginKey = new PluginKey<PluginState>('gravel-suggestion-diff')

interface PluginState {
  originalText: string
  decorations: DecorationSet
}

/**
 * Walk the doc, mapping each character offset in
 * `doc.textBetween(0, ..., '\n', '\n')` to its absolute doc position.
 * We rebuild this from scratch on every recompute — sub-millisecond
 * on prompt-sized docs and avoids stale incremental maps.
 */
function buildPosMap(doc: PmNode): { textPos: number; docPos: number }[] {
  const map: { textPos: number; docPos: number }[] = []
  let textPos = 0
  let lastTextEnd = -1
  doc.descendants((node, pos: number) => {
    if (node.isText) {
      // ProseMirror positions are contiguous for adjacent inline
      // text within the same block (e.g. `"hi "` followed by a
      // `<strong>` text node); a positive gap means we crossed a
      // block boundary, so add a virtual `\n` to match the
      // `textBetween(..., '\n', '\n')` separator on the diff side.
      if (lastTextEnd >= 0 && pos > lastTextEnd) textPos += 1
      map.push({ textPos, docPos: pos })
      const len = (node.text ?? '').length
      textPos += len
      lastTextEnd = pos + len
    }
    return true
  })
  // Sentinel so `textPosToDoc(textPos === total)` resolves to the end.
  map.push({ textPos, docPos: doc.content.size })
  return map
}

function textPosToDoc(
  map: { textPos: number; docPos: number }[],
  textPos: number,
): number {
  if (map.length === 0) return 0
  let lo = 0
  let hi = map.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (map[mid].textPos <= textPos) lo = mid
    else hi = mid - 1
  }
  const entry = map[lo]
  return entry.docPos + (textPos - entry.textPos)
}

class DeletionWidget {
  constructor(readonly text: string) {}
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'gravel-suggestion-deletion'
    // Whitespace-only deletions get a visible marker so the reader
    // notices the cut instead of seeing nothing.
    el.textContent = this.text.replace(/\n/g, '↵\n').replace(/\t/g, '→')
    return el
  }
}

function buildDecorations(doc: PmNode, originalText: string): DecorationSet {
  const currentText = doc.textBetween(0, doc.content.size, '\n', '\n')
  const changes = diffWordsWithSpace(originalText, currentText)
  const decorations: Decoration[] = []
  const posMap = buildPosMap(doc)
  let textCursor = 0 // position in currentText
  for (const change of changes) {
    if (change.added) {
      const from = textPosToDoc(posMap, textCursor)
      const to = textPosToDoc(posMap, textCursor + change.value.length)
      if (to > from) {
        decorations.push(
          Decoration.inline(from, to, {
            class: 'gravel-suggestion-insertion',
          }),
        )
      }
      textCursor += change.value.length
    } else if (change.removed) {
      const at = textPosToDoc(posMap, textCursor)
      decorations.push(
        Decoration.widget(at, () => new DeletionWidget(change.value).toDOM(), {
          // `side: -1` keeps the deletion widget visually anchored
          // before any insertion that landed at the same spot.
          side: -1,
          ignoreSelection: true,
        }),
      )
    } else {
      textCursor += change.value.length
    }
  }
  return DecorationSet.create(doc, decorations)
}

export const SuggestionDiff = Extension.create({
  name: 'gravelSuggestionDiff',
  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: pluginKey,
        state: {
          init(_: unknown, state: EditorState): PluginState {
            const originalText = ''
            return {
              originalText,
              decorations: buildDecorations(state.doc, originalText),
            }
          },
          apply(tr: Transaction, value: PluginState, _old: EditorState, newState: EditorState): PluginState {
            const meta = tr.getMeta(pluginKey) as { originalText?: string } | undefined
            const nextOriginal = meta?.originalText ?? value.originalText
            if (meta || tr.docChanged) {
              return {
                originalText: nextOriginal,
                decorations: buildDecorations(newState.doc, nextOriginal),
              }
            }
            return {
              originalText: nextOriginal,
              decorations: value.decorations.map(tr.mapping, tr.doc),
            }
          },
        },
        props: {
          decorations(this: Plugin<PluginState>, state: EditorState) {
            return this.getState(state)?.decorations ?? DecorationSet.empty
          },
        },
      }),
    ]
  },
})

/** Update the original-text the diff is computed against. Triggers a rebuild. */
export function setSuggestionDiffOriginal(view: EditorView, originalText: string): void {
  view.dispatch(view.state.tr.setMeta(pluginKey, { originalText }))
}
