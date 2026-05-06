/**
 * Prompt editor — read current text, accept a draft, save / discard, show
 * inline diff + Mallet analysis as the DE types.
 *
 * Spec: gravel-cloud/docs/spec/prompts.md §2 (edit flow), §5 (inline diff +
 * Mallet on edits).
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { SkeletonText } from '../components/Skeleton'
import { Badge } from '../components/Badge'
import { PromptBadge } from '../components/prompts/PromptBadge'
import { DiffView } from '../components/prompts/DiffView'
import { cx } from '../lib/format'
import type {
  AnalysisResponse,
  DraftsResponse,
  MalletIssue,
  PromptDetailResponse,
  PutDraftResponse,
} from '../lib/types'

export function PromptDetail({ promptId }: { promptId: string }) {
  const [, navigate] = useLocation()
  const queryClient = useQueryClient()

  const detailQ = useQuery<PromptDetailResponse>({
    queryKey: ['prompt', promptId],
    queryFn: () => api.get<PromptDetailResponse>(`/api/prompts/${promptId}`),
  })
  const draftsQ = useQuery<DraftsResponse>({
    queryKey: ['prompts', 'drafts'],
    queryFn: () => api.get<DraftsResponse>('/api/prompts/drafts'),
  })

  const existingDraft = draftsQ.data?.drafts.find((d) => d.promptId === promptId) ?? null
  const [draftText, setDraftText] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Seed the editor once we know the current text + any existing draft.
  useEffect(() => {
    if (draftText !== null) return
    if (!detailQ.data || draftsQ.isLoading) return
    setDraftText(existingDraft ? existingDraft.newText : detailQ.data.content)
  }, [detailQ.data, draftsQ.isLoading, existingDraft, draftText])

  const save = useMutation<PutDraftResponse, Error, string>({
    mutationFn: (newText) =>
      api.put<PutDraftResponse>(`/api/prompts/${promptId}`, { newText }),
    onSuccess: (data) => {
      setToast(`Draft saved on branch ${data.draftBranch}`)
      queryClient.invalidateQueries({ queryKey: ['prompts', 'drafts'] })
      // Spec §2: "After save, returns user to /prompts with the row marked
      // 'draft'." Wait a beat so the toast is readable in tests + real use.
      window.setTimeout(() => navigate('/prompts'), 600)
    },
  })

  const discard = useMutation<{ ok: true }, Error, void>({
    mutationFn: () => api.delete<{ ok: true }>(`/api/prompts/${promptId}/draft`),
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
  const draftBranch = draftsQ.data?.draftBranch ?? null

  return (
    <div className="space-y-4">
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

      <div className="grid gap-4 md:grid-cols-2">
        <section>
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-text-mid">
            Current
          </h2>
          <pre
            className="h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-warm bg-warm/30 p-3 font-mono text-xs leading-relaxed text-text-dark"
            data-testid="current-pane"
          >
            {detail.content}
          </pre>
        </section>
        <section>
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-text-mid">
            Draft
          </h2>
          <textarea
            value={editorText}
            onChange={(e) => setDraftText(e.target.value)}
            spellCheck={false}
            aria-label="Draft prompt text"
            className="h-80 w-full resize-none rounded-xl border border-warm bg-white p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </section>
      </div>

      <section>
        <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-text-mid">
          Inline diff
        </h2>
        <DiffView before={detail.content} after={editorText} />
      </section>

      <MalletPanel text={editorText} />

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

/**
 * Mallet analysis panel. Debounces draft text changes and POSTs them to
 * `/api/analysis`. The endpoint may not exist in every embedding app — if
 * we get a 404 we render a friendly fallback rather than a scary error.
 */
function MalletPanel({ text }: { text: string }) {
  const [debounced, setDebounced] = useState(text)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setDebounced(text), 800)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [text])

  const analyzeQ = useQuery<AnalysisResponse, Error>({
    queryKey: ['analysis', debounced],
    enabled: debounced.trim().length > 0,
    queryFn: () => api.post<AnalysisResponse>('/api/analysis', { prompt: debounced }),
  })

  const notAvailable = analyzeQ.isError && /\b404\b/.test(analyzeQ.error?.message ?? '')

  return (
    <section className="rounded-2xl border border-warm bg-cream p-3" data-testid="mallet-panel">
      <header className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-mid">
          Mallet analysis
        </h2>
        {analyzeQ.isFetching && <span className="text-[11px] text-text-muted">analyzing…</span>}
      </header>
      {notAvailable ? (
        <p className="mt-2 text-xs text-text-mid">
          Mallet analysis not available in this build.
        </p>
      ) : analyzeQ.isError ? (
        <p className="mt-2 font-mono text-xs text-primary-dark">{analyzeQ.error.message}</p>
      ) : !analyzeQ.data ? (
        <p className="mt-2 text-xs text-text-muted">
          Edit the draft to see live analysis.
        </p>
      ) : analyzeQ.data.issues.length === 0 ? (
        <p className="mt-2 text-xs text-text-mid">No issues found.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {analyzeQ.data.issues.map((issue, i) => (
            <IssueRow key={`${issue.type}-${issue.range[0]}-${i}`} issue={issue} />
          ))}
        </ul>
      )}
    </section>
  )
}

function IssueRow({ issue }: { issue: MalletIssue }) {
  const tone =
    issue.severity === 'error' ? 'bad' : issue.severity === 'warning' ? 'warn' : 'info'
  return (
    <li className="flex items-start gap-2 text-xs">
      <Badge tone={tone}>{issue.severity}</Badge>
      <span className="text-text-dark">{issue.message}</span>
    </li>
  )
}
