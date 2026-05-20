/**
 * SuggestionEditor — WYSIWYG markdown editor for prompts.
 *
 * Underlying model: Tiptap (ProseMirror). The DOM you see IS the
 * rendered markdown — headings get heading sizes, bold renders bold,
 * lists indent, etc. We round-trip to a markdown string for save +
 * PR via tiptap-markdown's serializer, so the on-disk truth stays a
 * markdown file.
 *
 * The toolbar above the editor exposes the formatting actions you'd
 * expect from Google Docs / Notion: headings, bold/italic/code,
 * bullet/ordered lists, quote, link. Each maps to a single
 * ProseMirror command via Tiptap's chain API.
 *
 * The "Reset" affordance is the parent's responsibility — we just emit
 * onChange with the raw markdown text. Same for save / discard.
 *
 * NOTE: the Google-Docs-style inline insertion/deletion overlay that
 * lived on the previous CodeMirror implementation is gone for now;
 * representing those reliably as ProseMirror marks while keeping the
 * markdown round-trip stable is a separate problem. The diff stats
 * (`+12 −3` at word granularity) are still surfaced via onDiffStats.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { Editor as CoreEditor, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { diffWordsWithSpace } from 'diff'
import {
  Bold,
  Code,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  type LucideIcon,
} from 'lucide-react'
import { cx } from '../../lib/format'
import {
  SuggestionDiff,
  setSuggestionDiffOriginal,
} from './SuggestionDiff'

/**
 * `tiptap-markdown` augments `editor.storage` at runtime with a
 * `markdown.getMarkdown()` helper, but its package doesn't declare a
 * matching `Storage` augmentation. Cast through the runtime shape to
 * keep tsc happy without lying about the wider Storage type.
 *
 * Post-processes the serialiser's output:
 *
 * 1. **Un-escape dashes / underscores / asterisks / hashes that aren't
 *    load-bearing for prompts.** The default markdown-it serialiser is
 *    conservative — it sees `--- ORIGINAL OUTPUT ---` and worries that
 *    a CommonMark reader might mis-parse it as a horizontal rule, so it
 *    emits `\--- ORIGINAL OUTPUT \---`. For prompt files this is hostile:
 *    every round-trip introduces a phantom diff and prompts that aren't
 *    rendered to HTML never actually need the escapes. We strip them.
 *
 * 2. **Preserve single newlines.** With tiptap-markdown's default
 *    parser, `header\ncontent` round-trips as `header content` because
 *    the soft break is dropped. We pair this with `breaks: true` on the
 *    parser side; together, single newlines in the source become hard
 *    breaks in the doc and survive a round-trip unchanged.
 *
 * Bug surfaced by Yousef's PR #247 review on de_platform — opening an
 * unedited prompt showed +5/-2 diff stats from the editor alone, which
 * frightens domain experts into thinking they accidentally edited.
 */
function getMarkdown(editor: Editor, original: string): string {
  const storage = editor.storage as { markdown?: { getMarkdown: () => string } }
  const raw = storage.markdown?.getMarkdown() ?? editor.getText()
  return alignWhitespace(original, undoConservativeEscapes(raw))
}

/**
 * When the serialiser's only divergence from the original is which
 * whitespace it picked — inserting `\n\n` before a list item that
 * originally had a single `\n`, stripping a trailing newline, normalising
 * leading whitespace — return the ORIGINAL verbatim. This makes mounting
 * an unedited prompt produce a zero diff regardless of the parser's
 * paragraph-vs-list normalisation or CommonMark serialiser conventions.
 *
 * When the user has made real content changes (the sequence of
 * non-whitespace runs differs in count or value), trust the candidate
 * and accept whatever whitespace normalisation Tiptap applied — that's a
 * tractable tradeoff: edits preserve content faithfully; unedited
 * content is byte-perfect.
 *
 * Token model: split on /\s+/ and drop empties — leaves only the
 * sequence of non-whitespace runs. If that sequence is identical
 * between original and candidate, every difference is whitespace-only.
 * This is robust against trailing-newline drift (the CommonMark
 * serialiser doesn't emit a trailing `\n` even if the source has one)
 * AND paragraph-to-list separator normalisation (single `\n` → `\n\n`).
 */
export function alignWhitespace(original: string, candidate: string): string {
  const origTokens = original.split(/\s+/).filter(Boolean)
  const candTokens = candidate.split(/\s+/).filter(Boolean)
  if (origTokens.length !== candTokens.length) return candidate
  for (let i = 0; i < origTokens.length; i++) {
    if (origTokens[i] !== candTokens[i]) return candidate
  }
  return original
}

/**
 * Undo the over-zealous backslash escapes tiptap-markdown emits to
 * defend against CommonMark mis-parses. Prompts are read by LLMs, not
 * markdown renderers; the escapes are pure noise and bite the diff.
 *
 * Two classes of escape to strip:
 *
 * 1. **Structural-char escapes** — `\-`, `\_`, `\*`, `\#`. tiptap-markdown
 *    emits these to defend against `---` being read as a horizontal
 *    rule, `*foo*` as emphasis, etc. Prompts don't render as markdown
 *    so the escapes round-trip as visible noise (`\---` instead of
 *    `---`). Yousef's PR #247 was the canonical case.
 *
 * 2. **Hard-break backslashes** — `\<newline>`. With `breaks: true`,
 *    single newlines in the source parse as hard breaks; on serialise
 *    tiptap-markdown emits them as `\` followed by a literal newline
 *    (CommonMark's explicit hard-break syntax). Source had a plain
 *    `\n` — the round-trip should give us back a plain `\n`, not
 *    `\\\n`. Yousef's landlord-ai dogfooding caught this: every single
 *    newline in a prompt contributed a phantom +1/-0 diff.
 *
 * Conservative: only strips a `\` when it precedes one of `-_*#\n` AND
 * the resulting text wouldn't change meaning under normal prompt usage.
 * We don't touch `\\` (literal backslash) or other escapes; fenced code
 * blocks aren't a concern in practice for prompt files.
 */
export function undoConservativeEscapes(md: string): string {
  return md.replace(/\\([-_*#\n])/g, '$1')
}

/**
 * Normalise a markdown string into the same plain-text shape that
 * `editor.state.doc.textBetween(...)` produces for the live document.
 *
 * Why a transient editor rather than regex stripping: tiptap-markdown
 * uses markdown-it, which is CommonMark-compliant on tricky cases the
 * regex can't replicate (e.g. underscores inside identifiers — `_a_b_`
 * keeps the middle underscore; fenced code preserves whitespace; lists
 * vs. paragraphs use distinct block boundaries). The regex `_X_` rule
 * was over-eager and showed phantom diffs on unedited prompts.
 *
 * We spin a headless editor with the same extension set, parse the
 * markdown once, read textBetween, and destroy. tiptap-markdown's
 * parser is hooked into the editor lifecycle, so this is the
 * canonical path to a roundtrip-stable baseline.
 */
function markdownToDocText(md: string, extensions: Extensions): string {
  const ed = new CoreEditor({ extensions, content: md })
  const text = ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n', '\n')
  ed.destroy()
  return text
}

/**
 * Strip the most common markdown syntax markers so the result roughly
 * matches what Tiptap emits as the doc's `textBetween`. Kept as a
 * fallback / for tests; the live diff uses {@link markdownToDocText}
 * which goes through tiptap-markdown's real parser. Edge cases here
 * (intraword underscores, fenced code with backticks in body) misalign,
 * which is why production uses the parser path.
 */
export function markdownToPlainText(md: string): string {
  return md
    // fenced code blocks: drop fence lines, keep the code body
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    // setext-style headings underlines (=== / ---)
    .replace(/^(.+)\n[=-]{2,}\s*$/gm, '$1')
    // ATX headings: drop the leading hashes
    .replace(/^#{1,6}\s+/gm, '')
    // blockquote markers
    .replace(/^>\s?/gm, '')
    // list bullets and ordered markers
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // emphasis / strong / strikethrough
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // inline code
    .replace(/`([^`]+)`/g, '$1')
    // images: keep the alt text only
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // links: keep the text only
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // horizontal rule lines: drop entirely
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    // collapse runs of blank lines to a single newline so the result
    // aligns with what Tiptap emits for `textBetween` with a single
    // `\n` block separator. Without this, every paragraph break in
    // the original shows up as a spurious deletion in the inline
    // diff, even on an unedited prompt.
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/** Word-level insertion / deletion totals — used by the parent for the "+12 −3" badge. */
export function computeDiffStats(original: string, current: string): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  for (const change of diffWordsWithSpace(original, current)) {
    // Word boundaries don't always match exact word boundaries of intent,
    // so count by characters within each chunk — same scale the user
    // sees as "+N −M" and matches the unit the diff lib actually emits.
    if (change.added) insertions += change.value.length
    else if (change.removed) deletions += change.value.length
  }
  return { insertions, deletions }
}

export type EditorStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface SuggestionEditorProps {
  /** The unedited prompt body (server truth). Used for diff stats. */
  original: string
  /** Current draft markdown text. The parent controls this so it can persist drafts. */
  value: string
  onChange: (next: string) => void
  /** Surfaces the live diff stats so the parent can show "+12 / −3". */
  onDiffStats?: (stats: { insertions: number; deletions: number }) => void
  /** Optional aria-label override; default "Prompt draft". */
  ariaLabel?: string
  /** Auto-save status; renders a small indicator on the right of the toolbar. */
  status?: EditorStatus
}

export function SuggestionEditor({
  original,
  value,
  onChange,
  onDiffStats,
  ariaLabel = 'Prompt draft',
  status = 'idle',
}: SuggestionEditorProps) {
  // Latest callbacks live in refs so onChange/onDiffStats identity
  // changes don't tear down the editor.
  const onChangeRef = useRef(onChange)
  const onDiffStatsRef = useRef(onDiffStats)
  const originalRef = useRef(original)
  onChangeRef.current = onChange
  onDiffStatsRef.current = onDiffStats
  originalRef.current = original

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // History is included by default in StarterKit; everything else
        // ships with sensible markdown-friendly defaults. We disable the
        // built-in code block highlight (StarterKit ships the basic
        // codeBlock; a syntax-highlighted variant is overkill for a
        // prompt editor and would drag in a parser dep).
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-primary underline underline-offset-2 hover:text-primary-dark',
        },
      }),
      Placeholder.configure({
        placeholder: 'Start writing your prompt…',
      }),
      // Markdown round-trip: parses the initial value as markdown into
      // the doc, and `getMarkdown(editor)` serialises
      // back to a markdown string for save.
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: false,
        // Treat newlines in the source as hard breaks. Prompts are not
        // rendered to HTML; the user writes line-by-line and expects
        // each newline to survive a round-trip. With `breaks: false`
        // (the markdown-it default), `header\ncontent` collapses to
        // `header content` on serialise. See PR #247 on de_platform
        // for the regression that drove this change.
        breaks: true,
        transformPastedText: true,
      }),
      SuggestionDiff,
    ],
    [],
  )

  const editor = useEditor({
    extensions,
    content: value,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        'data-testid': 'suggestion-editor-content',
        // `gravel-prose` styles (defined in editor.css below) give
        // headings, lists, code, quote etc. the visual treatment
        // expected of a WYSIWYG markdown editor without dragging in
        // @tailwindcss/typography.
        class: 'gravel-prose focus:outline-none px-4 py-3 leading-relaxed',
      },
    },
    onUpdate({ editor }) {
      const md: string = getMarkdown(editor, originalRef.current)
      onChangeRef.current(md)
      const stats = computeDiffStats(originalRef.current, md)
      onDiffStatsRef.current?.(stats)
    },
  })

  // Push parent-driven value changes (e.g. "Reset" sets value back to
  // original) into the editor. Skip when the markdown already matches
  // re-setting content would clobber the cursor on every keystroke.
  useEffect(() => {
    if (!editor) return
    const current: string = getMarkdown(editor, originalRef.current)
    if (current === value) return
    editor.commands.setContent(value, { emitUpdate: false })
    // Re-emit diff stats after a parent-driven content swap.
    onDiffStatsRef.current?.(computeDiffStats(originalRef.current, value))
  }, [editor, value])

  // Re-emit diff stats AND push the new original-text into the
  // SuggestionDiff plugin whenever the original itself changes (or
  // the editor finishes mounting). We parse the original markdown
  // through a transient editor (same extensions) so its
  // `textBetween` shape exactly matches what the live editor will
  // emit — otherwise the inline diff shows phantom changes for
  // tokens like `needs_human` where markdown-it and the regex
  // approximation disagree.
  useEffect(() => {
    if (!editor) return
    const current: string = getMarkdown(editor, original)
    onDiffStatsRef.current?.(computeDiffStats(original, current))
    setSuggestionDiffOriginal(editor.view, markdownToDocText(original, extensions))
  }, [editor, original, extensions])

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-warm bg-white"
      data-testid="suggestion-editor"
    >
      <MarkdownToolbar editor={editor} status={status} />
      <div className="min-h-0 flex-1 cursor-text overflow-y-auto">
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  )
}

// ---------- Toolbar ----------

interface ToolbarButtonProps {
  icon: LucideIcon
  title: string
  onClick: () => void
  active?: boolean
  testId?: string
}

function ToolbarButton({ icon: Icon, title, onClick, active, testId }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-testid={testId}
      onMouseDown={(e) => {
        // Keep editor focus.
        e.preventDefault()
        onClick()
      }}
      className={cx(
        'flex h-7 w-7 cursor-pointer items-center justify-center rounded transition',
        active
          ? 'bg-warm text-text-dark'
          : 'text-text-mid hover:bg-warm/40 hover:text-text-dark',
      )}
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  )
}

function ToolbarSeparator() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-warm" />
}

function MarkdownToolbar({ editor, status }: { editor: Editor | null; status: EditorStatus }) {
  if (!editor) {
    return (
      <div
        className="flex items-center gap-0.5 border-b border-warm bg-cream/60 px-2 py-1"
        data-testid="suggestion-editor-toolbar"
        aria-hidden
      />
    )
  }
  const promptForLink = () => {
    const previous: string = editor.getAttributes('link').href ?? ''
    // eslint-disable-next-line no-alert
    const url = window.prompt('Link URL', previous)
    if (url === null) return
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    }
  }
  return (
    <div
      className="flex flex-wrap items-center gap-0.5 border-b border-warm bg-cream/60 px-2 py-1"
      data-testid="suggestion-editor-toolbar"
    >
      <ToolbarButton
        icon={Heading1}
        title="Heading 1"
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      />
      <ToolbarButton
        icon={Heading2}
        title="Heading 2"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <ToolbarButton
        icon={Heading3}
        title="Heading 3"
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <ToolbarSeparator />
      <ToolbarButton
        icon={Bold}
        title="Bold"
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        icon={Italic}
        title="Italic"
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        icon={Code}
        title="Inline code"
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
      <ToolbarButton
        icon={FileCode2}
        title="Code block"
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      />
      <ToolbarSeparator />
      <ToolbarButton
        icon={List}
        title="Unordered list"
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        icon={ListOrdered}
        title="Ordered list"
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton
        icon={Quote}
        title="Block quote"
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <ToolbarSeparator />
      <ToolbarButton
        icon={LinkIcon}
        title="Insert or edit link"
        active={editor.isActive('link')}
        onClick={promptForLink}
      />
      <SaveStatus status={status} />
    </div>
  )
}

function SaveStatus({ status }: { status: EditorStatus }) {
  // Reserve the slot at all times (`ml-auto`) so toolbar buttons don't
  // jump as the indicator transitions between idle / saving / saved.
  return (
    <span
      className="ml-auto flex h-5 min-w-[5rem] items-center justify-end gap-1 text-[11px] text-text-muted"
      aria-live="polite"
      data-testid="suggestion-editor-status"
      data-status={status}
    >
      {status === 'saving' && (
        <>
          <Spinner />
          <span>Saving</span>
        </>
      )}
      {status === 'saved' && <span className="text-forest">Saved</span>}
      {status === 'error' && <span className="text-primary-dark">Save failed</span>}
    </span>
  )
}

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border border-text-muted/40 border-t-text-mid"
      aria-hidden
    />
  )
}
