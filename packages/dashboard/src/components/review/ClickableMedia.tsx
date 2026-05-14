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
import { useState, type ReactNode } from 'react'

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
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group inline-flex cursor-pointer items-center gap-2 rounded border border-warm bg-warm/30 px-3 py-1.5 text-xs transition hover:border-forest/50 hover:bg-warm/50"
        aria-label={`open ${title}`}
      >
        {thumbnail ?? (
          <>
            <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">
              PDF
            </span>
            <span className="font-medium text-text-dark">{title}</span>
            <span className="text-[10px] text-text-muted transition group-hover:text-forest">
              open
            </span>
          </>
        )}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel={`${title} (enlarged)`}
        size="centred"
      >
        <div className="flex h-full flex-col">
          <header className="flex items-center justify-between border-b border-warm px-4 py-2 text-xs">
            <span className="font-medium text-text-dark">{title}</span>
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-muted underline hover:text-forest"
            >
              open in new tab
            </a>
          </header>
          <iframe
            src={src}
            title={title}
            className="flex-1 bg-white"
          />
        </div>
      </Dialog>
    </>
  )
}
