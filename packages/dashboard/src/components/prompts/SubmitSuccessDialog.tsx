/**
 * "Your changes are in for review" success dialog.
 *
 * Replaces the v0.7.x inline green strip on Prompts.tsx, which Yousef's
 * dogfooding session flagged as "not very visible". A modal forces the
 * user to acknowledge the success path — important because once they
 * dismiss it the bulk-submit button reverts to disabled.
 *
 * Shows the PR URL with a Copy action + a "View on GitHub" link.
 */
import { useState } from 'react'
import { Modal } from '../Modal'

export function SubmitSuccessDialog({
  prUrl,
  onClose,
}: {
  prUrl: string | null
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
      // Clipboard write can fail on Safari private mode etc. — fall
      // back silently; the URL is still selectable inside the modal.
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Your changes are in for review"
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
      <p className="text-sm text-text-dark">
        Gravel opened a pull request from the gravel-bot account. Your
        engineer or repo owner can review and merge it from GitHub.
      </p>
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
