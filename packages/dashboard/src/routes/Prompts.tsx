/**
 * Prompts list — surface the manifest, group by directory, let the DE see
 * which prompts have an in-flight draft, and submit all drafts as one PR.
 *
 * Spec: gravel-cloud/docs/spec/prompts.md §2 (edit flow), §3 (no "new
 * prompt" button + empty-state copy), §6 (GitHub OAuth gating), §9 (search).
 */
import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { EmptyState } from '../components/EmptyState'
import { DeveloperNote } from '../components/DeveloperNote'
import { SkeletonText } from '../components/Skeleton'
import { PromptBadge } from '../components/prompts/PromptBadge'
import { SubmitModal, type SubmitDraftEntry } from '../components/prompts/SubmitModal'
import { cx } from '../lib/format'
import type {
  DraftsResponse,
  GithubStatusResponse,
  ManifestPromptListItem,
  PromptDetailResponse,
  PromptsListResponse,
} from '../lib/types'
import { PromptDetail } from './PromptDetail'

export function PromptsPage({ promptId }: { promptId?: string } = {}) {
  if (promptId) return <PromptDetail promptId={promptId} />
  return <PromptsList />
}

function PromptsList() {
  const [search, setSearch] = useState('')
  const [submitOpen, setSubmitOpen] = useState(false)
  const [submittedPrUrl, setSubmittedPrUrl] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const promptsQ = useQuery<PromptsListResponse>({
    queryKey: ['prompts'],
    queryFn: () => api.get<PromptsListResponse>('/api/prompts'),
  })
  const draftsQ = useQuery<DraftsResponse>({
    queryKey: ['prompts', 'drafts'],
    queryFn: () => api.get<DraftsResponse>('/api/prompts/drafts'),
  })
  const ghQ = useQuery<GithubStatusResponse>({
    queryKey: ['github', 'status'],
    queryFn: () => api.get<GithubStatusResponse>('/api/github/status'),
  })

  const draftsByPromptId = useMemo(() => {
    const map = new Map<string, DraftsResponse['drafts'][number]>()
    for (const d of draftsQ.data?.drafts ?? []) map.set(d.promptId, d)
    return map
  }, [draftsQ.data])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const all = promptsQ.data?.prompts ?? []
    if (!q) return all
    return all.filter(
      (p) =>
        p.path.toLowerCase().includes(q) ||
        (p.varName?.toLowerCase().includes(q) ?? false),
    )
  }, [promptsQ.data, search])

  const grouped = useMemo(() => groupByDirectory(filtered), [filtered])

  // For the SubmitModal we need each draft paired with the prompt's *current*
  // text so we can show a meaningful diff. Fetch on demand only when the
  // modal opens.
  const draftPreviewsQ = useQuery<SubmitDraftEntry[]>({
    queryKey: ['prompts', 'submit-preview', draftsQ.data?.drafts.map((d) => d.id).join(',')],
    enabled: submitOpen && (draftsQ.data?.drafts.length ?? 0) > 0,
    queryFn: async () => {
      const drafts = draftsQ.data?.drafts ?? []
      const prompts = promptsQ.data?.prompts ?? []
      const byId = new Map(prompts.map((p) => [p.id, p]))
      const entries: SubmitDraftEntry[] = []
      for (const draft of drafts) {
        const prompt = byId.get(draft.promptId)
        if (!prompt) continue
        const detail = await api.get<PromptDetailResponse>(`/api/prompts/${draft.promptId}`)
        entries.push({ draft, prompt, before: detail.content })
      }
      return entries
    },
  })

  const hasDrafts = (draftsQ.data?.drafts.length ?? 0) > 0
  const ghConnected = ghQ.data?.connected === true

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text-dark">Prompts</h1>
          <p className="mt-1 text-sm text-text-mid">
            Edit any prompt in your repo. Submit accumulates into one PR.
          </p>
        </div>
        <button
          type="button"
          disabled={!hasDrafts}
          aria-disabled={!hasDrafts}
          title={!hasDrafts ? 'Edit a prompt first.' : ''}
          className={cx(
            'rounded-lg px-3 py-1.5 text-sm font-medium text-white',
            hasDrafts
              ? 'cursor-pointer bg-primary hover:bg-primary-dark'
              : 'cursor-not-allowed bg-primary/40',
          )}
          onClick={() => setSubmitOpen(true)}
        >
          Submit changes{hasDrafts && ` (${draftsQ.data?.drafts.length ?? 0})`}
        </button>
      </header>

      {/*
        GH App install is dev-only setup. Domain experts can't (and
        shouldn't) wire up a bot; they just want to edit a prompt. When
        the App is installed by the dev once on the repo, every viewer's
        "Submit changes" goes through it. The repo binding happens at
        install time on github.com — no separate repo-picker needed.
      */}
      {ghQ.data && !ghConnected && (
        <DeveloperNote>
          <GithubBanner />
        </DeveloperNote>
      )}

      {submittedPrUrl && (
        <div className="rounded-2xl border border-forest/30 bg-forest/5 p-3 text-sm text-forest">
          PR opened —{' '}
          <a
            href={submittedPrUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer underline"
          >
            view on GitHub
          </a>
          .
        </div>
      )}

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by path or var name…"
        aria-label="Search prompts"
        className="w-full max-w-md rounded-md border border-warm bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
      />

      {promptsQ.isLoading ? (
        <div className="rounded-2xl border border-warm bg-cream p-4">
          <SkeletonText lines={5} />
        </div>
      ) : promptsQ.isError ? (
        <p className="rounded-2xl border border-primary/30 bg-primary/5 p-4 font-mono text-xs text-primary-dark">
          {(promptsQ.error as Error)?.message ?? 'Failed to load prompts.'}
        </p>
      ) : (promptsQ.data?.prompts.length ?? 0) === 0 ? (
        <div className="space-y-3">
          <EmptyState
            title="No prompts yet"
            body="Once your team has prompts wired up, they'll appear here for editing."
          />
          <DeveloperNote>
            Prompts come from the manifest. Add one in your code, then run{' '}
            <code className="rounded bg-cream px-1 py-0.5 font-mono text-[11px]">
              npx @artanis-ai/gravel manifest --update
            </code>
            .
          </DeveloperNote>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No matches"
          body={`Nothing matches "${search}". Try a different path or var name.`}
        />
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <DirectoryGroup
              key={group.dir}
              dir={group.dir}
              prompts={group.prompts}
              draftsByPromptId={draftsByPromptId}
            />
          ))}
        </div>
      )}

      <SubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        drafts={draftPreviewsQ.data ?? []}
        onSubmitted={(result) => {
          setSubmittedPrUrl(result.pr.prUrl)
          queryClient.invalidateQueries({ queryKey: ['prompts', 'drafts'] })
        }}
      />

    </div>
  )
}

interface Group {
  dir: string
  prompts: ManifestPromptListItem[]
}

function groupByDirectory(prompts: ManifestPromptListItem[]): Group[] {
  const map = new Map<string, ManifestPromptListItem[]>()
  for (const p of prompts) {
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '.'
    const arr = map.get(dir) ?? []
    arr.push(p)
    map.set(dir, arr)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, prompts]) => ({
      dir,
      prompts: prompts.slice().sort((a, b) => a.path.localeCompare(b.path)),
    }))
}

function DirectoryGroup({
  dir,
  prompts,
  draftsByPromptId,
}: {
  dir: string
  prompts: ManifestPromptListItem[]
  draftsByPromptId: Map<string, DraftsResponse['drafts'][number]>
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className="overflow-hidden rounded-2xl border border-warm bg-cream">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between bg-warm/40 px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-text-mid hover:bg-warm/60"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {dir}
        </span>
        <span className="font-mono text-[11px] text-text-muted">{prompts.length}</span>
      </button>
      {open && (
        <ul>
          {prompts.map((p) => {
            const file = p.path.includes('/') ? p.path.slice(p.path.lastIndexOf('/') + 1) : p.path
            const hasDraft = draftsByPromptId.has(p.id)
            return (
              <li key={p.id} className="border-t border-warm">
                <Link
                  href={`/prompts/${p.id}`}
                  className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-sm hover:bg-warm/30"
                  data-testid={`prompt-row-${p.id}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-text-dark">{file}</span>
                    {p.varName && (
                      <span className="font-mono text-xs text-text-muted">{p.varName}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    {hasDraft && (
                      <span
                        title="Unsubmitted draft"
                        aria-label="Has draft"
                        className="inline-block h-2 w-2 rounded-full bg-primary"
                      />
                    )}
                    <PromptBadge type={p.type} />
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function GithubBanner() {
  const install = useMutation<{ redirectUrl: string }, Error, void>({
    mutationFn: () => api.get<{ redirectUrl: string }>('/api/github/install'),
    onSuccess: (data) => {
      window.location.href = data.redirectUrl
    },
  })
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-accent/15 p-3 text-sm text-earth-dark">
      <span>
        Install the Gravel GitHub App on your repo so domain experts can submit prompt edits as PRs.
        The repo binds at install time — no separate repo-picker step.
      </span>
      <button
        type="button"
        disabled={install.isPending}
        className="cursor-pointer rounded-lg bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-primary/60"
        onClick={() => install.mutate()}
      >
        {install.isPending ? 'Redirecting…' : 'Install GitHub App'}
      </button>
    </div>
  )
}

