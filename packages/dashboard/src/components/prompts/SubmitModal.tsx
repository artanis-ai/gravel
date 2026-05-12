/**
 * "Submit changes" confirmation modal.
 *
 * Drafts are read from the browser's localStorage by the parent and
 * passed in. On submit we POST them inline in the request body — the
 * server doesn't persist drafts.
 *
 * Spec: gravel-cloud/docs/spec/prompts.md §2 (submission step 8 — list each
 * draft's path + before/after diff snippet, optional title + description).
 *
 * Owns its own form state + the POST mutation so it can be unit-tested in
 * isolation from the prompts list.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Modal } from '../Modal'
import { PromptBadge } from './PromptBadge'
import { DiffView } from './DiffView'
import { api } from '../../lib/api'
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
  const [error, setError] = useState<string | null>(null)
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
    onError: (err) => setError(err.message),
  })

  function onFormSubmit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      setError('Title is required.')
      return
    }
    if (!name.trim()) {
      setError('Your name is required so the PR can credit it.')
      return
    }
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
            disabled={submit.isPending || drafts.length === 0}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium text-white',
              submit.isPending || drafts.length === 0
                ? 'cursor-not-allowed bg-primary/60'
                : 'cursor-pointer bg-primary hover:bg-primary-dark',
            )}
          >
            {submit.isPending ? 'Opening PR…' : 'Open PR'}
          </button>
        </>
      }
    >
      <form id="submit-prompts-form" onSubmit={onFormSubmit} className="space-y-4">
        <p className="text-xs text-text-mid">
          {drafts.length} draft{drafts.length === 1 ? '' : 's'} will be submitted as one PR
          to your connected repo.
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
          PR title
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

        {error && <p className="text-xs text-primary-dark">{error}</p>}
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
