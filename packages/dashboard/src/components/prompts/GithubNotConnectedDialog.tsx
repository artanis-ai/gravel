/**
 * Shown when a reviewer hits "Submit changes" but the Gravel GitHub
 * App isn't installed on the repo yet, so we have nowhere to open
 * the PR. The dashboard is read by domain experts (clinicians,
 * lawyers, analysts), not by developers, so the copy hands the work
 * back to the developer with the exact command they need to run.
 */
import { Modal } from '../Modal'

export function GithubNotConnectedDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ask your developer to connect GitHub"
      size="lg"
      footer={
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-warm px-3 py-1.5 text-sm hover:bg-warm"
          onClick={onClose}
        >
          Got it
        </button>
      }
    >
      <div className="space-y-4 text-sm text-text-mid">
        <p>
          Your changes are saved as drafts in this browser, but the Gravel
          GitHub App isn&rsquo;t installed on the repo yet, so there&rsquo;s
          nowhere to open the pull request.
        </p>

        <p>
          Ask the developer who set up Gravel for this app to install the
          GitHub App on your repo. Once that&rsquo;s done, your drafts
          will become real PRs from this dashboard.
        </p>

        <div className="rounded-xl border border-warm bg-white p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            For the developer
          </p>
          <p className="mt-1 text-xs">
            Open this dashboard on your laptop (anywhere on{' '}
            <code className="font-mono text-text-dark">localhost</code>)
            and click{' '}
            <span className="font-medium text-text-dark">Install GitHub App</span>{' '}
            in the developer notice at the top of the prompts page. That
            walks you through the GitHub App install on the right repo.
          </p>
        </div>

        <p className="text-xs text-text-muted">
          Your drafts stay where they are while you wait, nothing is lost.
        </p>
      </div>
    </Modal>
  )
}
