/**
 * Prompts list — surface the manifest, group by directory, let the DE see
 * which prompts have an in-flight draft, and submit all drafts as one PR.
 *
 * Drafts live in this browser's localStorage (see lib/drafts.ts). The
 * submit endpoint accepts them inline in the POST body.
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
import { CopyableCode } from '../components/CopyableCode'
import { SkeletonText } from '../components/Skeleton'
import { PromptBadge } from '../components/prompts/PromptBadge'
import { SubmitModal, type SubmitDraftEntry } from '../components/prompts/SubmitModal'
import { listDrafts, type LocalDraft } from '../lib/drafts'
import { useCurrentUser } from '../lib/useCurrentUser'
import type {
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
  const userId = useCurrentUser()?.id ?? null

  const promptsQ = useQuery<PromptsListResponse>({
    queryKey: ['prompts'],
    queryFn: () => api.get<PromptsListResponse>('/api/prompts'),
  })
  const draftsQ = useQuery<LocalDraft[]>({
    queryKey: ['prompts', 'drafts', userId],
    enabled: userId !== null,
    queryFn: () => Promise.resolve(userId ? listDrafts(userId) : []),
  })
  const ghQ = useQuery<GithubStatusResponse>({
    queryKey: ['github', 'status'],
    queryFn: () => api.get<GithubStatusResponse>('/api/github/status'),
  })

  const draftsByPromptId = useMemo(() => {
    const map = new Map<string, LocalDraft>()
    for (const d of draftsQ.data ?? []) map.set(d.promptId, d)
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
    queryKey: ['prompts', 'submit-preview', (draftsQ.data ?? []).map((d) => d.promptId).join(',')],
    enabled: submitOpen && (draftsQ.data?.length ?? 0) > 0,
    queryFn: async () => {
      const drafts = draftsQ.data ?? []
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

  const hasDrafts = (draftsQ.data?.length ?? 0) > 0
  const ghConnected = ghQ.data?.connected === true

  return (
    <div className="space-y-6">
      <DeveloperNote>
        <p>
          To re-scan your codebase for prompts, run{' '}
          <CopyableCode>npx @artanis-ai/gravel manifest --update</CopyableCode>
          .
        </p>
        {ghQ.data && !ghConnected && (
          <div className="mt-3 border-t border-accent/40 pt-3">
            <GithubBanner />
          </div>
        )}
      </DeveloperNote>

      <header className="flex flex-wrap items-center gap-3">
        <SearchField value={search} onChange={setSearch} />
        {hasDrafts && (
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            onClick={() => setSubmitOpen(true)}
          >
            Submit changes ({draftsQ.data?.length ?? 0})
          </button>
        )}
      </header>

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

      {promptsQ.isLoading ? (
        <div className="rounded-2xl border border-warm bg-cream p-4">
          <SkeletonText lines={5} />
        </div>
      ) : promptsQ.isError ? (
        <p className="rounded-2xl border border-primary/30 bg-primary/5 p-4 font-mono text-xs text-primary-dark">
          {(promptsQ.error as Error)?.message ?? 'Failed to load prompts.'}
        </p>
      ) : (promptsQ.data?.prompts.length ?? 0) === 0 ? (
        <EmptyState
          title="No prompts yet"
          body="Once your team has prompts wired up, they'll appear here for editing."
        />
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
  draftsByPromptId: Map<string, LocalDraft>
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

/**
 * Search field with a leading magnifier icon + clearable affordance.
 * Sized to match the height of the adjacent button so they sit on
 * the same baseline in the page header.
 */
function SearchField({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="relative flex-1 min-w-[12rem]">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search prompts"
        aria-label="Search prompts"
        className="w-full rounded-lg border border-warm bg-white py-2 pl-9 pr-9 text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute inset-y-0 right-2 flex cursor-pointer items-center px-1 text-text-muted hover:text-text-dark"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="6" y1="18" x2="18" y2="6" />
          </svg>
        </button>
      )}
    </div>
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
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span>
        Install the Gravel GitHub App on your repo so domain experts can submit prompt edits as PRs.
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
