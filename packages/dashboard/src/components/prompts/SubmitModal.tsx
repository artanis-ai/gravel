/**
 * "Submit changes" confirmation modal.
 *
 * Spec: gravel-cloud/docs/spec/prompts.md §2 (submission step 8 — list each
 * draft's path + before/after diff snippet, optional title + description).
 *
 * Owns its own form state + the POST mutation so it can be unit-tested in
 * isolation from the prompts list.
 */
import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Modal } from '../Modal'
import { PromptBadge } from './PromptBadge'
import { DiffView } from './DiffView'
import { api } from '../../lib/api'
import { cx } from '../../lib/format'
import type {
  DraftRow,
  ManifestPromptListItem,
  PromptType,
  SubmitPrResult,
} from '../../lib/types'

export interface SubmitDraftEntry {
  draft: DraftRow
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
  const [error, setError] = useState<string | null>(null)

  const submit = useMutation<SubmitPrResult, Error, void>({
    mutationFn: () =>
      api.post<SubmitPrResult>('/api/prompts/submit', {
        title: title.trim() || undefined,
        description: description.trim() || undefined,
      }),
    onSuccess: (result) => {
      setError(null)
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
    submit.mutate()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit changes"
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
            <DraftRowPreview key={entry.draft.id} entry={entry} />
          ))}
        </ul>

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
