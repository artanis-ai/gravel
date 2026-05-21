/**
 * Prompts list — surface the manifest, group by directory, let the DE see
 * which prompts have an in-flight draft, and submit all drafts as one PR.
 *
 * Drafts live in this browser's localStorage (see lib/drafts.ts). The
 * submit endpoint accepts them inline in the POST body.
 *
 * prompt" button + empty-state copy), §6 (GitHub OAuth gating), §9 (search).
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { api, ApiError } from '../lib/api'
import { EmptyState } from '../components/EmptyState'
import { DeveloperNote } from '../components/DeveloperNote'
import { CopyableCode } from '../components/CopyableCode'
import { Alert } from '../components/Alert'
import { Spinner } from '../components/Spinner'
import { SkeletonText } from '../components/Skeleton'
import { PromptBadge } from '../components/prompts/PromptBadge'
import { SubmitModal, type SubmitDraftEntry } from '../components/prompts/SubmitModal'
import { SubmitSuccessDialog } from '../components/prompts/SubmitSuccessDialog'
import { GithubNotConnectedDialog } from '../components/prompts/GithubNotConnectedDialog'
import { listDrafts, type LocalDraft } from '../lib/drafts'
import { gravelCommand } from '../lib/runtime'
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
  const [needsGithubOpen, setNeedsGithubOpen] = useState(false)
  const [submittedPr, setSubmittedPr] = useState<{ url: string; isAmendment: boolean } | null>(
    null,
  )
  // Set briefly when the user arrives here from PromptDetail's
  // "Submit →" button. The bulk-submit pulses for 2.5s to teach the
  // user where to click next.
  const [pulseSubmit, setPulseSubmit] = useState(false)
  useEffect(() => {
    try {
      if (sessionStorage.getItem('gravel:focus-submit-once') === '1') {
        sessionStorage.removeItem('gravel:focus-submit-once')
        setPulseSubmit(true)
        // Scroll the button into view + remove the pulse class after
        // the animation cycle so subsequent visits don't keep pulsing.
        requestAnimationFrame(() => {
          document
            .querySelector('[data-testid="submit-changes"]')
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
        const t = window.setTimeout(() => setPulseSubmit(false), 2500)
        return () => window.clearTimeout(t)
      }
    } catch {
      /* sessionStorage unavailable (private mode etc.) */
    }
  }, [])
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
  // After the install callback redirects back with `?gh=installed`,
  // the four GRAVEL_GH_* env vars are in .env.local but the developer
  // still has to propagate them to their hosting platform (Vercel /
  // Doppler / Railway / etc) the same way they did for
  // GRAVEL_ADMIN_PASSWORD. Surface the reminder once via the
  // ?gh=installed query param so a fresh-install user sees it
  // automatically.
  const justInstalled =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('gh') === 'installed'

  return (
    <div className="space-y-6">
      <DeveloperNote>
        <p>
          To re-scan your codebase for prompts, run{' '}
          <CopyableCode>{gravelCommand('manifest --update')}</CopyableCode>
          .
        </p>
        {justInstalled && ghConnected && (
          <div className="mt-3 border-t border-accent/40 pt-3">
            <p className="font-medium">✓ gravel-bot installed locally.</p>
            <p className="mt-1">
              Don't forget: copy these four env vars to your production hosting
              env (Vercel / Doppler / Railway / etc) — same as{' '}
              <code className="text-xs">GRAVEL_ADMIN_PASSWORD</code>. PR
              submission won't work in prod without them:
            </p>
            <ul className="ml-5 mt-1 list-disc space-y-0.5 text-xs">
              <li>
                <code>GRAVEL_GH_INSTALL_ID</code>
              </li>
              <li>
                <code>GRAVEL_GH_INSTALL_SECRET</code>
              </li>
              <li>
                <code>GRAVEL_GH_REPO_OWNER</code>
              </li>
              <li>
                <code>GRAVEL_GH_REPO_NAME</code>
              </li>
            </ul>
          </div>
        )}
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
            className={
              'shrink-0 cursor-pointer rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark' +
              (pulseSubmit ? ' gravel-submit-pulse' : '')
            }
            data-testid="submit-changes"
            onClick={() => {
              // Without a connected repo we have nowhere to open the PR;
              // explain the gap rather than letting the submit POST 4xx
              // with a server-side error message the DE can't act on.
              if (!ghConnected) setNeedsGithubOpen(true)
              else setSubmitOpen(true)
            }}
          >
            Submit changes ({draftsQ.data?.length ?? 0})
          </button>
        )}
      </header>

      <SubmitSuccessDialog
        prUrl={submittedPr?.url ?? null}
        isAmendment={submittedPr?.isAmendment ?? false}
        onClose={() => setSubmittedPr(null)}
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <PromptCard
              key={p.id}
              prompt={p}
              hasDraft={draftsByPromptId.has(p.id)}
            />
          ))}
        </div>
      )}

      <SubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        drafts={draftPreviewsQ.data ?? []}
        onSubmitted={(result) => {
          setSubmittedPr({
            url: result.pr.prUrl,
            isAmendment: Boolean(result.pr.isAmendment),
          })
          queryClient.invalidateQueries({ queryKey: ['prompts', 'drafts'] })
        }}
      />

      <GithubNotConnectedDialog
        open={needsGithubOpen}
        onClose={() => setNeedsGithubOpen(false)}
      />

    </div>
  )
}

function PromptCard({
  prompt,
  hasDraft,
}: {
  prompt: ManifestPromptListItem
  hasDraft: boolean
}) {
  const file = prompt.path.includes('/')
    ? prompt.path.slice(prompt.path.lastIndexOf('/') + 1)
    : prompt.path
  return (
    <Link
      href={`/prompts/${prompt.id}`}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-warm bg-cream p-4 shadow-sm transition hover:border-primary/50 hover:shadow-md"
      data-testid={`prompt-card-${prompt.id}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium text-text-dark">
            {file}
          </div>
          {prompt.varName && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
              {prompt.varName}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {prompt.pushed === false && (
            <span
              title="This file hasn't been pushed to your team's codebase yet"
              aria-label="Not pushed"
              className="inline-flex items-center rounded-md border border-amber-300/60 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900"
            >
              Unpushed
            </span>
          )}
          {hasDraft && (
            <span
              title="Unsubmitted draft"
              aria-label="Has draft"
              className="inline-block h-2 w-2 rounded-full bg-primary"
            />
          )}
          <PromptBadge type={prompt.type} />
        </div>
      </header>
      <p className="mt-3 line-clamp-5 whitespace-pre-wrap text-xs leading-snug text-text-mid">
        {prompt.preview || (
          <span className="italic text-text-muted">(empty)</span>
        )}
      </p>
    </Link>
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

interface AlreadyInstalledResponse {
  installed: boolean
  installationId: number | null
  installedAt: string | null
  repoOwner: string | null
  repoName: string | null
  reason?: string
}

function GithubBanner() {
  // Pre-flight: ask the CP whether gravel-bot is already installed on
  // this checkout's repo. If yes, the user's local `.env.local` is
  // missing the GRAVEL_GH_INSTALL_* vars but the install itself is
  // live at the org level — clicking "Install" would dead-end the
  // user at GitHub's org settings page (GH's behaviour for repeat
  // installs). Surface guidance instead. Yousef's de-platform install
  // 2026-05-21 was the canonical case.
  //
  // Failures fall through to the normal Install button — if the CP
  // is unreachable or doesn't know about the repo, we still want the
  // user to be able to attempt a fresh install.
  const preflightQ = useQuery<AlreadyInstalledResponse>({
    queryKey: ['github', 'already-installed-on-repo'],
    queryFn: () =>
      api.get<AlreadyInstalledResponse>('/api/github/already-installed-on-repo'),
    staleTime: 60_000,
  })
  const install = useMutation<{ redirectUrl: string }, Error, void>({
    mutationFn: () => api.get<{ redirectUrl: string }>('/api/github/install'),
    onSuccess: (data) => {
      window.location.href = data.redirectUrl
    },
  })
  const busy = install.isPending || install.isSuccess

  // Already-installed branch: show the env-var copy guidance + the
  // manage URL, hide the Install button. The CP install/start route
  // also intercepts if the user pastes the install URL directly —
  // belt-and-suspenders.
  if (preflightQ.data?.installed) {
    const d = preflightQ.data
    const manageUrl =
      d.repoOwner && d.installationId
        ? `https://github.com/organizations/${encodeURIComponent(d.repoOwner)}/settings/installations/${d.installationId}`
        : null
    return (
      <div className="space-y-2">
        <p className="font-medium">
          gravel-bot is already installed on{' '}
          <code className="text-xs">
            {d.repoOwner}/{d.repoName}
          </code>{' '}
          (installation #{d.installationId}).
        </p>
        <p>
          To use it from this checkout, ask the engineer who installed it for
          these four env vars from their <code className="text-xs">.env.local</code>{' '}
          and paste them into yours:
        </p>
        <ul className="ml-5 list-disc space-y-0.5 text-xs">
          <li>
            <code>GRAVEL_GH_INSTALL_ID</code>
          </li>
          <li>
            <code>GRAVEL_GH_INSTALL_SECRET</code>
          </li>
          <li>
            <code>GRAVEL_GH_REPO_OWNER</code>
          </li>
          <li>
            <code>GRAVEL_GH_REPO_NAME</code>
          </li>
        </ul>
        <p className="text-xs text-text-muted">
          Same four vars also need to land in your production env (Vercel /
          Doppler / etc) the same way <code>GRAVEL_ADMIN_PASSWORD</code> does —
          PR submission won't work in prod without them.
        </p>
        {manageUrl && (
          <p className="text-xs">
            <a
              href={manageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="cursor-pointer text-primary underline"
            >
              Manage gravel-bot on GitHub
            </a>{' '}
            — uninstall there if you want to reinstall as yourself.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>
          Install the Gravel GitHub App on your repo so domain experts can submit prompt edits as PRs.
        </span>
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-text-muted disabled:hover:bg-text-muted"
          onClick={() => install.mutate()}
        >
          {busy && <Spinner className="text-white" label="Opening GitHub" />}
          {busy ? 'Opening GitHub…' : 'Install GitHub App'}
        </button>
      </div>
      {install.error && (
        <Alert title="Install failed" details={apiErrorDetails(install.error)}>
          {apiErrorMessage(install.error)}
        </Alert>
      )}
    </div>
  )
}

/** Pull the most informative message off an `ApiError` (or fall back). */
function apiErrorMessage(err: Error): string {
  if (err instanceof ApiError) return err.serverMessage || err.message
  return err.message || 'Please try again.'
}

function apiErrorDetails(err: Error): string | null {
  if (!(err instanceof ApiError)) return null
  if (err.details == null) return null
  if (typeof err.details === 'string') return err.details
  try {
    return JSON.stringify(err.details, null, 2)
  } catch {
    return String(err.details)
  }
}
