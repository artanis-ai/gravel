/**
 * Inline code snippet with a copy-to-clipboard button. Used wherever
 * we surface a CLI command the dev should run — empty-state hints,
 * the update banner, the doctor output, etc. Centralised so all such
 * snippets share the same affordance + accessibility wiring.
 *
 * Renders as `<code>` for screen readers; copy button is keyboard-
 * focusable and announces "Copied" via aria-live.
 */
import { useState } from 'react'

export function CopyableCode({
  children,
  className = '',
}: {
  /** The exact text to copy. Also rendered visually. */
  children: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(children)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* unsupported (rare): nothing to do — the text is selectable */
    }
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded bg-cream px-1.5 py-0.5 align-middle ring-1 ring-warm ${className}`}
    >
      <code className="font-mono text-[11px] text-text-dark">{children}</code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
        className="cursor-pointer text-text-muted hover:text-text-dark"
      >
        {copied ? <CheckIcon /> : <ClipboardIcon />}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  )
}

function ClipboardIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-forest"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
