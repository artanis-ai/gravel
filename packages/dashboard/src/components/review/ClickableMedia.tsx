/**
 * ClickableMedia — wraps an inline image or PDF thumbnail so it
 * becomes clickable into a full-size lightbox.
 *
 * Used by every renderer that surfaces an image (OpenAIChat
 * multimodal, AnthropicMessages image block, LangchainChatModel
 * image part) and by the Anthropic document (PDF) block. Adds
 * `cursor-pointer` + a hover opacity tween + a hover ring so the
 * affordance reads as interactive. Click opens the existing
 * `<Dialog>` (Escape + backdrop close) with the asset rendered at
 * its natural size, fit inside the viewport.
 */
import { useState, type MouseEvent, type ReactNode } from 'react'

import { Dialog } from '../Dialog'

interface ClickableImageProps {
  /** `src` for the `<img>` — works for both `https://...` and
   *  `data:image/...;base64,...` URIs. */
  src: string
  /** Optional alt text. Defaults to "image". */
  alt?: string
  /** Tailwind class string applied to the thumbnail `<img>`. The
   *  hover affordance is added automatically. */
  className?: string
  /** Optional caption shown in the lightbox header. */
  caption?: string
}

export function ClickableImage({
  src,
  alt = 'image',
  className,
  caption,
}: ClickableImageProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative inline-block cursor-pointer overflow-hidden rounded border border-warm transition hover:border-forest/50 hover:shadow-md"
        aria-label={`open ${alt}`}
      >
        <img
          src={src}
          alt={alt}
          className={`${className ?? 'max-h-48 max-w-xs'} block transition group-hover:opacity-90`}
        />
        <span className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/30 text-xs font-medium uppercase tracking-wide text-white group-hover:flex">
          click to enlarge
        </span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel={`${alt} (enlarged)`}
        size="centred"
      >
        <div className="flex h-full flex-col">
          {caption && (
            <header className="border-b border-warm px-4 py-2 text-xs text-text-muted">
              {caption}
            </header>
          )}
          <div className="flex flex-1 items-center justify-center overflow-auto bg-warm/20 p-4">
            <img
              src={src}
              alt={alt}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </div>
      </Dialog>
    </>
  )
}

interface ClickablePdfProps {
  /** `src` for the `<iframe>` — usually a `data:application/pdf;base64,...`
   *  URI or an `https://...` URL. */
  src: string
  /** Document title for the lightbox header. */
  title?: string
  /** Optional thumbnail content. When omitted, a simple icon + title
   *  pill is rendered. */
  thumbnail?: ReactNode
}

export function ClickablePdf({
  src,
  title = 'document',
  thumbnail,
}: ClickablePdfProps): ReactNode {
  const [open, setOpen] = useState(false)

  // Default rendering: an inline iframe preview the user can read
  // directly in the input panel, plus an "Enlarge" affordance that
  // opens the full-screen dialog. Yousef's dogfooding flagged the
  // previous "tiny button → tiny preview" pattern as too easy to
  // miss. The thumbnail-only shape (when an explicit thumbnail is
  // passed) is preserved for compact contexts that opt in.
  if (thumbnail) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group inline-flex cursor-pointer items-center gap-2 rounded border border-warm bg-warm/30 px-3 py-1.5 text-xs transition hover:border-forest/50 hover:bg-warm/50"
          aria-label={`open ${title}`}
        >
          {thumbnail}
        </button>
        <PdfDialog open={open} onClose={() => setOpen(false)} src={src} title={title} />
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-text-dark">{title}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="cursor-pointer rounded-md border border-warm bg-warm/30 px-2 py-1 text-[11px] text-text-mid hover:bg-warm/60 hover:text-text-dark"
          aria-label={`enlarge ${title}`}
        >
          Enlarge
        </button>
      </div>
      <iframe
        src={src}
        title={title}
        className="min-h-[70vh] w-full flex-1 rounded-lg border border-warm bg-white"
      />
      <PdfDialog open={open} onClose={() => setOpen(false)} src={src} title={title} />
    </div>
  )
}

/**
 * The full-screen enlarge dialog. Lifted out of ClickablePdf so both
 * code paths (with + without an explicit thumbnail) share the same
 * UX. "Open in new tab" converts a data URI to a blob URL on click —
 * directly using a `data:` URI as the anchor's href opens about:blank
 * in modern Chrome/Firefox by policy.
 */
function PdfDialog({
  open,
  onClose,
  src,
  title,
}: {
  open: boolean
  onClose: () => void
  src: string
  title: string
}) {
  function openInNewTab(e: MouseEvent<HTMLAnchorElement>) {
    if (!src.startsWith('data:')) return // plain URL — let the anchor work normally
    e.preventDefault()
    try {
      const b64 = src.slice(src.indexOf(',') + 1)
      const mediaType = src.slice(5, src.indexOf(';'))
      const bin = atob(b64)
      const buf = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
      const blob = new Blob([buf], { type: mediaType || 'application/pdf' })
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      // The blob URL is alive for the page lifetime. Revoke on next
      // tick once the new tab has had a chance to load.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      window.open(src, '_blank')
    }
  }
  return (
    <Dialog open={open} onClose={onClose} ariaLabel={`${title} (enlarged)`} size="fullscreen">
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-warm px-4 py-2 text-xs">
          <span className="font-medium text-text-dark">{title}</span>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            onClick={openInNewTab}
            className="cursor-pointer text-text-muted underline hover:text-forest"
          >
            open in new tab
          </a>
        </header>
        <iframe src={src} title={title} className="flex-1 bg-white" />
      </div>
    </Dialog>
  )
}
