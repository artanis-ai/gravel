/**
 * "Submitted for engineering review" success dialog.
 *
 * Replaces the v0.7.x inline green strip on Prompts.tsx, which Yousef's
 * dogfooding session flagged as "not very visible". A modal forces the
 * user to acknowledge the success path; once they dismiss it the
 * bulk-submit button reverts to disabled.
 *
 * Copy is deliberately domain-expert-facing (no "PR" / "GitHub" /
 * "repo" terms in the title or body). The URL panel + "View on
 * GitHub" button are still shown for the engineer who reviews it.
 * Earlier copy "Your changes are in for review" caused users to look
 * at the dashboard's Review tab instead.
 */
import { useState } from 'react'
import { Modal } from '../Modal'

export function SubmitSuccessDialog({
  prUrl,
  isAmendment,
  onClose,
}: {
  prUrl: string | null
  /** True when the submission was added to an already-open Gravel
   *  PR rather than opening a new one. Drives the copy: "added to
   *  your existing submission" vs "submitted for engineering review". */
  isAmendment?: boolean
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  if (!prUrl) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(prUrl ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write can fail on Safari private mode etc.; fall
      // back silently; the URL is still selectable inside the modal.
    }
  }

  const title = isAmendment
    ? 'Added to your existing submission'
    : 'Submitted for engineering review'
  const body = isAmendment
    ? 'Your changes were added to the submission that’s already with engineering. They’ll see the update next time they review it.'
    : 'Your engineers can now review and apply your changes. Nothing further to do on your end.'

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-warm bg-warm/30 px-3.5 py-2 text-sm text-text-dark hover:bg-warm/60"
          >
            Close
          </button>
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            View on GitHub
          </a>
        </div>
      }
    >
      <p className="text-sm text-text-dark">{body}</p>
      <div className="mt-4 flex items-center gap-2 rounded-xl border border-warm bg-warm/30 p-3 font-mono text-xs">
        <span data-testid="submit-success-url" className="flex-1 truncate text-text-dark">
          {prUrl}
        </span>
        <button
          type="button"
          onClick={copy}
          className="cursor-pointer rounded-md border border-warm bg-cream px-2 py-1 text-[11px] font-medium text-text-muted hover:bg-warm/30 hover:text-text-dark"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Modal>
  )
}
