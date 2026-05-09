/**
 * OnboardingCard — first-run / next-action card pinned to the top of
 * the Prompts and Outputs tabs.
 *
 * Reads `/api/onboarding/status` (server) + a tiny localStorage layer
 * for "user dismissed this step" / "user has seen the welcome." The
 * server tells us what's wired up; the local state tells us what the
 * user's already acknowledged.
 *
 * Per pillar, the card walks through:
 *   prompts:  no manifest → run wizard
 *             manifest, no draft yet → "click any prompt to edit"
 *             draft, no GH App → "install the App so we can open a PR"
 *             everything wired → dismissable "you're set" pat
 *   traces:   no tables → "run gravel init --traces"
 *             tables, no samples → "trigger an LLM call from your app"
 *             samples, no feedback → "click a sample to leave feedback"
 *
 * Both pillars converge on a dismissable "you're all set" once the
 * happy path is complete. Dismissal is per-pillar, persisted in
 * localStorage by user id so view-as users see the welcome card again
 * on a fresh user.
 */
import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import { listDrafts } from '../lib/drafts'
import { useCurrentUser } from '../lib/useCurrentUser'
import type { OnboardingStatus } from '../lib/types'
import { CopyableCode } from './CopyableCode'

export type OnboardingPillar = 'prompts' | 'traces'

const STORAGE_PREFIX = 'gravel:onboarding-dismissed'

function dismissalKey(userId: string, pillar: OnboardingPillar): string {
  return `${STORAGE_PREFIX}:${pillar}:${userId}`
}

function readDismissed(userId: string, pillar: OnboardingPillar): boolean {
  try {
    return localStorage.getItem(dismissalKey(userId, pillar)) === '1'
  } catch {
    return false
  }
}

function writeDismissed(userId: string, pillar: OnboardingPillar, value: boolean): void {
  try {
    if (value) localStorage.setItem(dismissalKey(userId, pillar), '1')
    else localStorage.removeItem(dismissalKey(userId, pillar))
  } catch {
    /* ignore */
  }
}

// Cross-tab + manual-dismiss reactivity. useSyncExternalStore keeps
// the rendered state in sync with localStorage without polling.
const subscribers = new Set<() => void>()
function notify(): void {
  for (const cb of subscribers) cb()
}
function subscribe(cb: () => void): () => void {
  subscribers.add(cb)
  const onStorage = () => cb()
  window.addEventListener('storage', onStorage)
  return () => {
    subscribers.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

function useDismissed(userId: string | null, pillar: OnboardingPillar): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => (userId ? readDismissed(userId, pillar) : false),
    () => false,
  )
  const set = (v: boolean) => {
    if (!userId) return
    writeDismissed(userId, pillar, v)
    notify()
  }
  return [value, set]
}

export function OnboardingCard({ pillar }: { pillar: OnboardingPillar }) {
  const me = useCurrentUser()
  const userId = me?.id ?? null
  const [dismissed, setDismissed] = useDismissed(userId, pillar)
  const statusQ = useQuery<OnboardingStatus>({
    queryKey: ['onboarding-status'],
    queryFn: () => api.get<OnboardingStatus>('/api/onboarding/status'),
    // Refetch every time the user navigates between tabs so the card
    // reflects fresh manifest / DB state without a hard reload.
    staleTime: 30_000,
  })
  if (!statusQ.data) return null
  if (dismissed) return null

  const card =
    pillar === 'prompts'
      ? renderPrompts(statusQ.data, userId)
      : renderTraces(statusQ.data)
  if (!card) return null

  return (
    <section
      data-testid={`onboarding-${pillar}`}
      className="relative overflow-hidden rounded-2xl border border-accent/40 bg-accent/10 p-4 shadow-sm"
    >
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss onboarding card"
        className="absolute right-2 top-2 cursor-pointer rounded p-1 text-text-muted hover:bg-warm/50 hover:text-text-dark"
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
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      {card}
    </section>
  )
}

function renderPrompts(status: OnboardingStatus, userId: string | null): React.ReactNode {
  // Defensive partial-shape handling. Server is the source of truth,
  // but during a CP outage / test mocks we may see undefined nested
  // objects — fall through cleanly instead of crashing.
  const prompts = status.prompts ?? { manifestExists: false, promptCount: 0, hookInstalled: false }
  const githubApp = status.githubApp ?? { connected: false, repoOwner: null, repoName: null }
  const draftCount = userId ? listDrafts(userId).length : 0

  if (!prompts.manifestExists || prompts.promptCount === 0) {
    return (
      <Card
        title="Step 1 · Find your prompts"
        body={
          <>
            Gravel hasn't seen your prompts yet. Run a one-time scan from your repo
            root, then refresh this page:
            <CopyableCode>npx @artanis-ai/gravel manifest --update</CopyableCode>
            Or, if you skipped the prompts pillar earlier, set it up:
            <CopyableCode>npx @artanis-ai/gravel init --prompts</CopyableCode>
          </>
        }
      />
    )
  }

  if (draftCount === 0) {
    return (
      <Card
        title={`Step 2 · Make your first edit (${prompts.promptCount} prompt${prompts.promptCount === 1 ? '' : 's'} ready)`}
        body={
          <>
            Click any prompt below to open the editor. Try changing a word — Gravel
            will save it as a draft you can submit when you're ready.
            <span className="block pt-1 text-xs text-text-muted">
              Prompts are read from your repo's manifest at <code className="font-mono">.gravel/manifest.json</code>.
            </span>
          </>
        }
      />
    )
  }

  if (!githubApp.connected) {
    return (
      <Card
        title="Step 3 · Connect GitHub so we can open the PR"
        body={
          <>
            You have <strong>{draftCount}</strong> draft{draftCount === 1 ? '' : 's'} ready to
            submit. Install the Gravel GitHub App on the repo where prompt changes
            should land — domain experts won't need a GitHub account themselves.
            <span className="block pt-1 text-xs text-text-muted">
              Click "Submit changes" above when you're ready; the dashboard will
              walk you through the install if it's not done yet.
            </span>
          </>
        }
      />
    )
  }

  return (
    <Card
      title="You're set — submit when ready"
      body={
        <>
          {draftCount} draft{draftCount === 1 ? '' : 's'} pending. Click "Submit changes" above to
          open a PR through <code className="font-mono">{githubApp.repoOwner}/{githubApp.repoName}</code>.
        </>
      }
    />
  )
}

function renderTraces(status: OnboardingStatus): React.ReactNode {
  const traces = status.traces ?? { tablesExist: false, sampleCount: 0, hasFeedback: false }

  if (!traces.tablesExist) {
    return (
      <Card
        title="Step 1 · Set up tracing"
        body={
          <>
            Outputs are empty because Gravel's tables haven't been created yet.
            Run the traces pillar from your repo root:
            <CopyableCode>npx @artanis-ai/gravel init --traces</CopyableCode>
            This creates two tables (<code className="font-mono">gravel_samples</code>,{' '}
            <code className="font-mono">gravel_feedback</code>) and wires up auto-tracing
            for OpenAI, Anthropic, LangChain, and Vercel AI SDK.
          </>
        }
      />
    )
  }

  if (traces.sampleCount === 0) {
    return (
      <Card
        title="Step 2 · Trigger an LLM call"
        body={
          <>
            Tables are ready. Make a request to your app that hits OpenAI / Anthropic /
            LangChain / Vercel AI SDK / raw fetch — auto-tracing is on, so the call
            will land here as soon as it completes.
            <span className="block pt-1 text-xs text-text-muted">
              Refresh this page after firing a call. Don't see anything? Check{' '}
              <code className="font-mono">npx @artanis-ai/gravel doctor</code>.
            </span>
          </>
        }
      />
    )
  }

  if (!traces.hasFeedback) {
    return (
      <Card
        title={`Step 3 · Leave feedback on a sample (${traces.sampleCount} captured)`}
        body={
          <>
            Click any sample below to inspect input/output. Use the feedback panel to
            mark it as good or flag a correction — that's what your domain experts
            will use to drive prompt improvements.
          </>
        }
      />
    )
  }

  return null // happy path on traces — no card needed
}

function Card({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="pr-6">
      <h3 className="font-display text-base font-semibold text-text-dark">{title}</h3>
      <div className="mt-1 space-y-1 text-sm text-text-mid">{body}</div>
    </div>
  )
}
