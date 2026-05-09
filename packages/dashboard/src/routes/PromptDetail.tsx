/**
 * Prompt editor — single-pane CodeMirror surface (Mallet-shaped) where
 * the DE's edits show as Google-Docs-style suggestions: insertions
 * underlined green, deletions struck through inline. The actual edit
 * commits to a localStorage draft on save; the PR is opened from the
 * Prompts list "Submit changes" flow.
 *
 * Drafts live in this browser's localStorage (see lib/drafts.ts).
 *
 * Spec: gravel-cloud/docs/spec/prompts.md §2 (edit flow), §5 (inline diff).
 */
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { SkeletonText } from '../components/Skeleton'
import { Badge } from '../components/Badge'
import { PromptBadge } from '../components/prompts/PromptBadge'
import { SuggestionEditor } from '../components/prompts/SuggestionEditor'
import { cx } from '../lib/format'
import {
  draftBranchFor,
  getDraft,
  removeDraft,
  upsertDraft,
  type LocalDraft,
} from '../lib/drafts'
import { useCurrentUser } from '../lib/useCurrentUser'
import type { PromptDetailResponse } from '../lib/types'

export function PromptDetail({ promptId }: { promptId: string }) {
  const [, navigate] = useLocation()
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
  const [toast, setToast] = useState<string | null>(null)

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
      const branch = userId ? draftBranchFor(userId) : ''
      setToast(`Draft saved on branch ${branch}`)
      queryClient.invalidateQueries({ queryKey: ['prompts', 'drafts'] })
      // Spec §2: "After save, returns user to /prompts with the row marked
      // 'draft'." Wait a beat so the toast is readable in tests + real use.
      window.setTimeout(() => navigate('/prompts'), 600)
    },
  })

  const discard = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!userId) throw new Error('Not signed in')
      removeDraft(userId, promptId)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts', 'drafts'] })
      navigate('/prompts')
    },
  })

  if (detailQ.isLoading) {
    return (
      <div className="space-y-4">
        <SkeletonText lines={2} />
        <div className="rounded-2xl border border-warm bg-cream p-4">
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
  const draftBranch = userId ? draftBranchFor(userId) : null

  return (
    <div className="space-y-3">
      <div>
        <Link href="/prompts" className="cursor-pointer text-xs text-text-mid hover:text-text-dark">
          ← Back to prompts
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="font-display text-xl font-semibold text-text-dark">
            <code className="font-mono">{detail.path}</code>
          </h1>
          <PromptBadge type={detail.type} />
          {detail.varName && <Badge tone="neutral">{detail.varName}</Badge>}
          {existingDraft && <Badge tone="warn">draft</Badge>}
        </div>
        {draftBranch && (
          <p className="mt-1 font-mono text-[11px] text-text-muted">{draftBranch}</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 px-1 text-[11px] text-text-mid">
        <span>
          Edits show as suggestions: insertions underlined,{' '}
          <span className="italic">deletions struck through</span>.
        </span>
        {(stats.insertions > 0 || stats.deletions > 0) && (
          <span className="font-mono text-text-muted">
            <span className="text-forest">+{stats.insertions}</span>{' '}
            <span className="text-primary-dark">−{stats.deletions}</span>
          </span>
        )}
      </div>

      <div className="h-[28rem]">
        <SuggestionEditor
          original={detail.content}
          value={editorText}
          onChange={setDraftText}
          onDiffStats={setStats}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={save.isPending || !dirty}
          className={cx(
            'rounded-lg px-3 py-1.5 text-sm font-medium text-white',
            save.isPending || !dirty
              ? 'cursor-not-allowed bg-primary/40'
              : 'cursor-pointer bg-primary hover:bg-primary-dark',
          )}
          onClick={() => save.mutate(editorText)}
        >
          {save.isPending ? 'Saving…' : 'Save draft'}
        </button>
        {dirty && (
          <button
            type="button"
            className="cursor-pointer rounded-lg border border-warm px-3 py-1.5 text-sm font-medium text-text-mid hover:bg-warm/40"
            onClick={() => setDraftText(detail.content)}
          >
            Reset
          </button>
        )}
        {existingDraft && (
          <button
            type="button"
            disabled={discard.isPending}
            className={cx(
              'rounded-lg border px-3 py-1.5 text-sm font-medium',
              discard.isPending
                ? 'cursor-not-allowed border-warm text-text-muted'
                : 'cursor-pointer border-primary text-primary hover:bg-primary/10',
            )}
            onClick={() => discard.mutate()}
          >
            {discard.isPending ? 'Discarding…' : 'Discard draft'}
          </button>
        )}
        {toast && <span className="text-xs text-forest">{toast}</span>}
        {save.isError && (
          <span className="font-mono text-xs text-primary-dark">{save.error.message}</span>
        )}
      </div>
    </div>
  )
}
