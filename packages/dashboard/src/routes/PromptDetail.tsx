/**
 * Prompt editor — WYSIWYG markdown surface (Tiptap) with auto-save.
 *
 * The editor doc is rendered live (headings get heading sizes, bold
 * renders bold, lists indent), but the underlying truth is markdown:
 * we serialize on every change and persist that text to a localStorage
 * draft. The PR opened from the Prompts list "Submit changes" flow
 * uses the same markdown verbatim.
 *
 * Drafts live in this browser's localStorage (see lib/drafts.ts). Save
 * is debounced — the user types, we wait ~500ms of quiet, then flush.
 *
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { SkeletonText } from '../components/Skeleton'
import { Badge } from '../components/Badge'
import { PromptBadge } from '../components/prompts/PromptBadge'
import { SuggestionEditor, type EditorStatus } from '../components/prompts/SuggestionEditor'
import { cx } from '../lib/format'
import {
  getDraft,
  removeDraft,
  upsertDraft,
  type LocalDraft,
} from '../lib/drafts'
import { useCurrentUser } from '../lib/useCurrentUser'
import type { PromptDetailResponse } from '../lib/types'

const AUTOSAVE_DEBOUNCE_MS = 500
const SAVED_BADGE_LINGER_MS = 1500

export function PromptDetail({ promptId }: { promptId: string }) {
  const queryClient = useQueryClient()
  const me = useCurrentUser()
  const userId = me?.id ?? null

  const detailQ = useQuery<PromptDetailResponse>({
    queryKey: ['prompt', promptId],
    queryFn: () => api.get<PromptDetailResponse>(`/api/prompts/${promptId}`),
  })
  const draftQ = useQuery<LocalDraft | null>({
    queryKey: ['prompts', 'drafts', userId, promptId],
    enabled: userId !== null,
    queryFn: () => Promise.resolve(userId ? getDraft(userId, promptId) : null),
  })

  const existingDraft = draftQ.data ?? null
  const [draftText, setDraftText] = useState<string | null>(null)
  const [stats, setStats] = useState<{ insertions: number; deletions: number }>({
    insertions: 0,
    deletions: 0,
  })
  const [status, setStatus] = useState<EditorStatus>('idle')
  // Tracks the last value we successfully wrote to localStorage so the
  // auto-save effect can no-op when nothing changed since.
  const lastSavedTextRef = useRef<string | null>(null)
  const savedBadgeTimerRef = useRef<number | null>(null)

  // Seed the editor once we know the current text + any existing draft.
  useEffect(() => {
    if (draftText !== null) return
    if (!detailQ.data || draftQ.isLoading) return
    setDraftText(existingDraft ? existingDraft.newText : detailQ.data.content)
  }, [detailQ.data, draftQ.isLoading, existingDraft, draftText])

  const save = useMutation<LocalDraft, Error, string>({
    mutationFn: async (newText) => {
      if (!userId) throw new Error('Not signed in')
      return upsertDraft(userId, { promptId, newText })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts', 'drafts'] })
    },
  })

  const discard = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!userId) throw new Error('Not signed in')
      removeDraft(userId, promptId)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts', 'drafts'] })
      // Wipe the in-memory editor text too so the freshly-cleared
      // draft state matches what's now on disk; without this the
      // auto-save effect would immediately re-create the draft.
      setDraftText(detailQ.data?.content ?? '')
      lastSavedTextRef.current = detailQ.data?.content ?? null
    },
  })

  // Auto-save: whenever the draft text differs from server truth, schedule
  // a save after AUTOSAVE_DEBOUNCE_MS of quiet. Tracks save state on the
  // toolbar's right-side indicator. We compare against detail.content so
  // that "draft equals original" still suppresses needless writes, and
  // the parent's reset path emits the original text, which then no-ops.
  useEffect(() => {
    if (draftText === null) return
    if (!detailQ.data) return
    const original = detailQ.data.content
    // No-op: no draft worth saving (matches original AND no existing draft).
    if (draftText === original && !existingDraft) return
    // No-op: text hasn't changed since the last successful save.
    if (lastSavedTextRef.current === draftText) return

    const handle = window.setTimeout(() => {
      setStatus('saving')
      save.mutate(draftText, {
        onSuccess: () => {
          lastSavedTextRef.current = draftText
          setStatus('saved')
          if (savedBadgeTimerRef.current) window.clearTimeout(savedBadgeTimerRef.current)
          savedBadgeTimerRef.current = window.setTimeout(
            () => setStatus('idle'),
            SAVED_BADGE_LINGER_MS,
          )
        },
        onError: () => setStatus('error'),
      })
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftText, detailQ.data, existingDraft])

  // Cancel the linger timer on unmount so we don't setState-after-unmount.
  useEffect(
    () => () => {
      if (savedBadgeTimerRef.current) window.clearTimeout(savedBadgeTimerRef.current)
    },
    [],
  )

  if (detailQ.isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4">
        <SkeletonText lines={2} />
        <div className="flex-1 rounded-2xl border border-warm bg-cream p-4">
          <SkeletonText lines={8} />
        </div>
      </div>
    )
  }
  if (detailQ.isError || !detailQ.data) {
    return (
      <p className="rounded-2xl border border-primary/30 bg-primary/5 p-4 font-mono text-xs text-primary-dark">
        {(detailQ.error as Error)?.message ?? 'Failed to load prompt.'}
      </p>
    )
  }

  const detail = detailQ.data
  const editorText = draftText ?? detail.content
  const dirty = editorText !== detail.content

  // "Reset" and "Discard draft" used to be two buttons in a footer
  // bar. Functionally they were the same action plus a navigation
  // (Reset stayed, Discard navigated back to /prompts), so we
  // collapse them into a single button on the right of the title row
  // that reverts the editor text AND removes the draft entry from
  // localStorage. The footer bar goes away entirely so the editor
  // can take the full remaining height.
  const resetAndDiscard = () => {
    setDraftText(detail.content)
    if (existingDraft) discard.mutate()
  }

  // "Submit →" sends the user back to the prompt library where the
  // bulk-submit button lives. We don't open a per-prompt submit
  // dialog here because the wizard / dashboard model is "one PR with
  // every draft" — submitting from inside the editor would either
  // submit only this prompt (confusing partial state) or duplicate
  // the bulk page's modal. Instead we signal the bulk page to
  // pulse-highlight its Submit button so the next click is obvious.
  const PULSE_SIGNAL_KEY = 'gravel:focus-submit-once'
  const [, navigate] = useLocation()
  const goToSubmit = () => {
    try {
      sessionStorage.setItem(PULSE_SIGNAL_KEY, '1')
    } catch {
      /* Safari private mode etc. — the navigation still works, just
         without the pulse. */
    }
    navigate('/prompts')
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/prompts"
          className="cursor-pointer rounded-lg border border-warm px-2 py-1 text-xs font-medium text-text-mid hover:bg-warm/40 hover:text-text-dark"
          aria-label="Back to prompts"
        >
          ← Back
        </Link>
        <h1 className="font-display text-xl font-semibold text-text-dark">
          <code className="font-mono">{detail.path}</code>
        </h1>
        <PromptBadge type={detail.type} />
        {detail.varName && <Badge tone="neutral">{detail.varName}</Badge>}
        {existingDraft && <Badge tone="warn">draft</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {(stats.insertions > 0 || stats.deletions > 0) && (
            <span className="font-mono text-xs text-text-muted">
              <span className="text-forest">+{stats.insertions}</span>{' '}
              <span className="text-primary-dark">−{stats.deletions}</span>
            </span>
          )}
          {/* Persistent "Saved" indicator: stays visible as long as a
              draft exists. Tells the DE their work is safe AND that the
              next step is to open the Prompts page to submit. The
              transient version inside the editor toolbar still flashes
              on each auto-save; this one is the at-rest state. */}
          {existingDraft && (
            <Badge tone="good">Saved · not yet submitted</Badge>
          )}
          {(dirty || existingDraft) && (
            <>
              <button
                type="button"
                disabled={discard.isPending}
                className={cx(
                  'rounded-lg border px-2 py-1 text-xs font-medium',
                  discard.isPending
                    ? 'cursor-not-allowed border-warm text-text-muted'
                    : 'cursor-pointer border-warm text-text-mid hover:bg-warm/40 hover:text-text-dark',
                )}
                onClick={resetAndDiscard}
              >
                {discard.isPending ? 'Discarding…' : 'Reset'}
              </button>
              {existingDraft && (
                <button
                  type="button"
                  className="cursor-pointer rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary-dark"
                  onClick={goToSubmit}
                  data-testid="prompt-detail-submit"
                >
                  Submit →
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <SuggestionEditor
          original={detail.content}
          value={editorText}
          onChange={setDraftText}
          onDiffStats={setStats}
          status={status}
        />
      </div>

      {save.isError && (
        <p className="font-mono text-xs text-primary-dark">{save.error.message}</p>
      )}
    </div>
  )
}
