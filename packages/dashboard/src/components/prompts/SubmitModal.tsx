/**
 * "Submit changes" confirmation modal.
 *
 * Drafts are read from the browser's localStorage by the parent and
 * passed in. On submit we POST them inline in the request body — the
 * server doesn't persist drafts.
 *
 * draft's path + before/after diff snippet, optional title + description).
 *
 * Owns its own form state + the POST mutation so it can be unit-tested in
 * isolation from the prompts list.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Modal } from '../Modal'
import { toast } from '../Toast'
import { PromptBadge } from './PromptBadge'
import { DiffView } from './DiffView'
import { Alert } from '../Alert'
import { Spinner } from '../Spinner'
import { api, ApiError } from '../../lib/api'
import { cx } from '../../lib/format'
import { clearDrafts, type LocalDraft } from '../../lib/drafts'
import { useCurrentUser } from '../../lib/useCurrentUser'

const NAME_STORAGE_KEY = 'gravel:submitter-name'

function readCachedName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeCachedName(name: string): void {
  try {
    if (name) localStorage.setItem(NAME_STORAGE_KEY, name)
    else localStorage.removeItem(NAME_STORAGE_KEY)
  } catch {
    /* ignore — Safari private mode etc. */
  }
}
import type {
  ManifestPromptListItem,
  PromptType,
  SubmitPrResult,
} from '../../lib/types'

/**
 * The error state SubmitModal renders. Carries the friendly title
 * (humanised error code), the server's `message`, and the optional
 * raw upstream `details` (e.g. GitHub's response text). Falls back to
 * generic copy when one of the fields is missing.
 */
interface SubmitErrorState {
  title: string
  body: string
  details?: string | null
}

/**
 * Map server error codes to domain-expert-friendly title + body.
 * The raw server `message` (often a stack trace or nested 502 / 404
 * JSON) is folded into the Alert's `details` disclosure so engineers
 * can dig in without confronting users with line noise.
 */
function copyForCode(code: string): { title: string; body: string } {
  switch (code) {
    case 'github_not_installed':
      return {
        title: 'Engineering setup incomplete',
        body: "Your team's engineer needs to connect their codebase to Gravel before changes can be sent for review. Ask them to open the dashboard's setup and install the gravel-bot app.",
      }
    case 'github_failed':
      return {
        title: "Engineering side couldn't accept the change",
        body: "The bridge from Gravel to your team's code rejected this submission. Try again in a minute; if it persists, ask your engineer to check the gravel-bot app and the project repository.",
      }
    case 'github_token_mint_failed':
      return {
        title: "Gravel couldn't reach the engineering side",
        body: 'This is usually a temporary outage. Try again in a minute. If it keeps happening, ask your engineer to reinstall the gravel-bot app in your team’s repository.',
      }
    case 'unknown_prompt':
      return {
        title: 'One of your prompts looks unfamiliar',
        body: 'Refresh the page so the dashboard re-reads the prompts. If the same edit still fails, ask your engineer; the prompt may have been renamed or removed since you started editing.',
      }
    case 'prompt_no_position':
      return {
        title: "We can't locate one of your prompts",
        body: "Your engineer needs to re-scan the codebase so Gravel knows where each prompt lives. Ask them to run the manifest update.",
      }
    case 'prompt_unchanged':
      return {
        title: "One of your edits matches the current text",
        body: 'Either change the text, or remove this prompt from the submission. We only send actual edits for review.',
      }
    case 'no_drafts':
      return {
        title: 'Nothing to send yet',
        body: "There aren’t any draft edits ready. Edit a prompt first.",
      }
    case 'invalid_draft':
      return {
        title: 'Something looks off with the draft',
        body: "Refresh the page and try again. If it keeps happening, ask your engineer.",
      }
    case 'prompt_not_pushed':
      return {
        title: "Your engineer hasn't pushed the latest code yet",
        body: "One of the prompts you're editing isn't on the team's main branch yet. Ask your engineer to push their changes, then try again.",
      }
    default:
      return {
        title: "Couldn't send for review",
        body: 'Try again in a minute. If it keeps happening, share the technical details below with your engineer.',
      }
  }
}

export function defaultTitleForDrafts(drafts: SubmitDraftEntry[]): string {
  if (drafts.length === 0) return ''
  const basenames = drafts.map((d) => {
    const path = d.prompt.path
    return path.split('/').pop() || path
  })
  // "Update X, Y and Z" — verbatim format from Yousef's dogfooding
  // feedback. Single: "Update X". Two: "Update X and Y". 3+:
  // "Update X, Y and Z" (no Oxford comma).
  if (basenames.length === 1) return `Update ${basenames[0]}`
  if (basenames.length === 2) return `Update ${basenames[0]} and ${basenames[1]}`
  const head = basenames.slice(0, -1).join(', ')
  const tail = basenames[basenames.length - 1]
  return `Update ${head} and ${tail}`
}

function detailsToString(d: unknown): string | null {
  if (d == null) return null
  if (typeof d === 'string') return d
  try {
    return JSON.stringify(d, null, 2)
  } catch {
    return String(d)
  }
}

export interface SubmitDraftEntry {
  draft: LocalDraft
  prompt: ManifestPromptListItem
  /** Current text from the file/literal — used as the "before" in the diff. */
  before: string
}

export function SubmitModal({
  open,
  onClose,
  drafts,
  onSubmitted,
}: {
  open: boolean
  onClose: () => void
  drafts: SubmitDraftEntry[]
  onSubmitted: (result: SubmitPrResult) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<SubmitErrorState | null>(null)
  const me = useCurrentUser()

  // Name field priority:
  //   1. previously-typed value in localStorage (the dev or DE has
  //      already submitted a PR before — use what they used last time)
  //   2. firstName from getUser() if the host's auth provided one
  //   3. literal 'admin' for the localhost shortcut, since that
  //      matches what the auth shortcut tags the user with
  //   4. empty — DE types it themselves, gets cached for next time
  useEffect(() => {
    if (!open) return
    const cached = readCachedName()
    if (cached) {
      setName(cached)
      return
    }
    if (me?.id === 'localhost') setName('admin')
    else if (me?.firstName) setName(me.firstName)
  }, [open, me])

  // Prefill the title with a sensible default so reviewers see a
  // descriptive PR title without the DE having to think about it.
  // They can still edit before submitting. Single draft → use the
  // file's basename ("Update investigator.md"); multiple → count.
  useEffect(() => {
    if (!open) return
    if (title.trim()) return // don't clobber typed input on re-open
    setTitle(defaultTitleForDrafts(drafts))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, drafts])

  const submit = useMutation<SubmitPrResult, Error, void>({
    mutationFn: () =>
      api.post<SubmitPrResult>('/api/prompts/submit', {
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        submitterName: name.trim() || undefined,
        drafts: drafts.map((d) => ({
          promptId: d.draft.promptId,
          newText: d.draft.newText,
        })),
      }),
    onSuccess: (result) => {
      setError(null)
      writeCachedName(name.trim())
      if (me?.id) clearDrafts(me.id)
      setTitle('')
      setDescription('')
      onSubmitted(result)
      onClose()
    },
    onError: (err) => {
      const friendly =
        err instanceof ApiError
          ? copyForCode(err.code)
          : { title: "Couldn't send for review", body: err.message || 'Please try again.' }
      // Engineer-facing raw payload goes into the Alert's <details>
      // disclosure (and into the toast's optional details) so the
      // domain expert sees friendly copy first but can hand the
      // technical reason to their engineer if needed.
      const rawDetails =
        err instanceof ApiError
          ? (err.serverMessage ?? '') +
            (err.details ? '\n' + detailsToString(err.details) : '')
          : err.message || ''
      setError({
        title: friendly.title,
        body: friendly.body,
        details: rawDetails.trim() || undefined,
      })
      // Toast in parallel: if the user dismissed the modal between
      // submit click and 502 (or scrolled past the Alert), the toast
      // still flags the failure. Bottom-right, dismissable, 6 s.
      toast(`${friendly.title}. ${friendly.body}`, { tone: 'error', durationMs: 6000 })
    },
  })

  // Pre-flight: drafts whose underlying file isn't on the upstream
  // branch can't be sent for review yet (GitHub returns 404 when we
  // try to read the file). Surface this as a blocking warning at the
  // top of the modal + disable the submit button.
  const unpushedDrafts = drafts.filter((d) => d.prompt.pushed === false)

  function onFormSubmit(e: FormEvent) {
    e.preventDefault()
    if (unpushedDrafts.length > 0) {
      // Defence-in-depth: the submit button is already disabled in
      // this state, but in case it's clicked anyway, surface the
      // same Alert the warning block uses.
      setError({
        title:
          unpushedDrafts.length === 1
            ? "One of your prompts hasn't been pushed"
            : `${unpushedDrafts.length} of your prompts haven't been pushed`,
        body:
          'Push your team\'s codebase first, then come back and send for review.',
        details: unpushedDrafts.map((d) => d.prompt.path).join('\n'),
      })
      return
    }
    if (!title.trim()) {
      setError({ title: 'Title is required', body: 'Add a short title so reviewers know what changed.' })
      return
    }
    if (!name.trim()) {
      setError({
        title: 'Your name is required',
        body: 'We use it to credit the change to you in the review.',
      })
      return
    }
    setError(null)
    submit.mutate()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit changes"
      size="2xl"
      footer={
        <>
          <button
            type="button"
            className="cursor-pointer rounded-lg border border-warm px-3 py-1.5 text-sm hover:bg-warm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="submit-prompts-form"
            disabled={submit.isPending || drafts.length === 0 || unpushedDrafts.length > 0}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white',
              submit.isPending || drafts.length === 0 || unpushedDrafts.length > 0
                ? 'cursor-not-allowed bg-primary/60'
                : 'cursor-pointer bg-primary hover:bg-primary-dark',
            )}
          >
            {submit.isPending && <Spinner className="text-white" label="Sending" />}
            {submit.isPending ? 'Sending…' : 'Send for review'}
          </button>
        </>
      }
    >
      <form id="submit-prompts-form" onSubmit={onFormSubmit} className="space-y-4">
        {error && (
          <Alert
            title={error.title}
            details={error.details}
            onDismiss={() => setError(null)}
          >
            {error.body}
          </Alert>
        )}

        <p className="text-xs text-text-mid">
          {drafts.length} draft{drafts.length === 1 ? '' : 's'} will be sent to your team
          together for review.
        </p>

        <ul className="space-y-3">
          {drafts.map((entry) => (
            <DraftRowPreview key={entry.draft.promptId} entry={entry} />
          ))}
        </ul>

        <label className="flex flex-col gap-1 text-xs font-medium text-text-mid">
          Your name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Pat"
            className="w-full rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-text-mid">
          Title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Tighten triage prompt"
            autoFocus
            className="w-full rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-text-mid">
          Description (optional)
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Why this change."
            rows={3}
            className="w-full rounded-md border border-warm bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </label>

      </form>
    </Modal>
  )
}

function DraftRowPreview({ entry }: { entry: SubmitDraftEntry }) {
  const { prompt, draft, before } = entry
  return (
    <li className="rounded-lg border border-warm bg-white p-2.5">
      <div className="flex items-center gap-2 text-xs">
        <PromptBadge type={prompt.type as PromptType} />
        <code className="font-mono text-text-dark">{prompt.path}</code>
        {prompt.varName && (
          <span className="font-mono text-text-muted">· {prompt.varName}</span>
        )}
      </div>
      <div className="mt-2">
        <DiffView before={before} after={draft.newText} />
      </div>
    </li>
  )
}
