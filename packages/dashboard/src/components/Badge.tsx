import type { ReactNode } from 'react'
import { cx } from '../lib/format'

type Tone = 'neutral' | 'good' | 'bad' | 'warn' | 'info'

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-warm text-text-mid',
  good: 'bg-forest/15 text-forest',
  bad: 'bg-primary/15 text-primary-dark',
  warn: 'bg-accent/30 text-earth-dark',
  info: 'bg-earth-light/20 text-earth-dark',
}

/**
 * Small status pill. Color is paired with a leading glyph so color isn't the
 * only signal (spec/dashboard.md §8).
 */
export function Badge({ tone = 'neutral', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
      )}
    >
      {icon && <span aria-hidden="true">{icon}</span>}
      {children}
    </span>
  )
}
