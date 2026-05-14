/**
 * Message — a single chat-style bubble with a role chip + content area.
 *
 * Collapsible per the dashboard's long-standing convention:
 *   - Single message in a pane → starts open (renderer passes
 *     `initiallyOpen`).
 *   - `system` → starts collapsed (long static instructions; the
 *     reviewer rarely needs to re-read them on every sample).
 *   - `user` → starts collapsed except for the LAST user message,
 *     which is the turn the assistant is responding to and the
 *     reviewer needs visible immediately.
 *   - `assistant` / `tool` / `function` / `developer` / `unknown`
 *     → starts open.
 *
 * The Message component itself doesn't know about LAST-vs-not, so
 * renderers pass `initiallyOpen` explicitly. When collapsed, the
 * bubble shows a one-line `summary` next to the role chip; the
 * renderer is responsible for computing that summary because
 * content is opaque ReactNode here.
 */
import { useState, type ReactNode } from 'react'

import { HumanValue } from './HumanValue'

export type MessageRole =
  | 'system'
  | 'developer'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'function'
  | 'unknown'

interface MessageProps {
  role: MessageRole
  content: ReactNode
  /** Whether the bubble starts expanded. When omitted, defaults to
   *  `true` (always open). When `false`, the bubble renders only
   *  its role chip + one-line `summary` until the reviewer clicks. */
  initiallyOpen?: boolean
  /** One-line preview shown next to the role chip while collapsed.
   *  Renderers compute this from the underlying payload since
   *  Message can't introspect a ReactNode child. Optional only
   *  because top-level callers without collapse never need it. */
  summary?: string
  /** Optional small caption above the role chip (e.g. "step 2 of 3",
   *  "tool: get_weather", "id: chatcmpl-abc"). Stays visible even
   *  when the bubble is collapsed. */
  caption?: string
  /** Bubble outline variant. Falls back to a default keyed off role
   *  for system/tool/function unless explicitly overridden. */
  variant?: 'default' | 'tool' | 'reasoning' | 'system'
}

export function Message({
  role,
  content,
  initiallyOpen = true,
  summary,
  caption,
  variant = 'default',
}: MessageProps): ReactNode {
  const effectiveVariant =
    variant === 'default' && (role === 'system' || role === 'developer')
      ? 'system'
      : variant === 'default' && (role === 'tool' || role === 'function')
        ? 'tool'
        : variant
  const [open, setOpen] = useState(initiallyOpen)

  return (
    <div className={containerClass(effectiveVariant)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 cursor-pointer text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="font-mono text-[10px] text-text-muted">
            {open ? '▾' : '▸'}
          </span>
          <span className={roleChipClass(role, effectiveVariant)}>{labelForRole(role)}</span>
          {!open && summary && (
            <span className="truncate text-xs text-text-muted">{summary}</span>
          )}
        </span>
        {caption && <span className="text-[11px] text-text-muted">{caption}</span>}
      </button>
      {open && (
        <div className="mt-1.5 min-w-0">
          {typeof content === 'string' ? (
            <HumanValue value={content} />
          ) : isReactNode(content) ? (
            content
          ) : (
            <HumanValue value={content as unknown} />
          )}
        </div>
      )}
    </div>
  )
}

function containerClass(variant: 'default' | 'tool' | 'reasoning' | 'system'): string {
  const base = 'rounded-md border px-3 py-2 text-sm'
  switch (variant) {
    case 'tool':
      return `${base} border-warm bg-warm/30`
    case 'reasoning':
      return `${base} border-warm bg-warm/10 italic`
    case 'system':
      return `${base} border-warm bg-warm/20`
    default:
      return `${base} border-warm bg-white`
  }
}

function roleChipClass(_role: MessageRole, variant: string): string {
  const base =
    'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide'
  switch (variant) {
    case 'tool':
      return `${base} bg-forest/10 text-forest`
    case 'reasoning':
      return `${base} bg-warm text-text-muted`
    case 'system':
      return `${base} bg-warm text-text-dark`
    default:
      return `${base} bg-warm text-text-dark`
  }
}

function labelForRole(role: MessageRole): string {
  switch (role) {
    case 'system':
      return 'System'
    case 'developer':
      return 'Developer'
    case 'user':
      return 'User'
    case 'assistant':
      return 'Assistant'
    case 'tool':
      return 'Tool'
    case 'function':
      return 'Function'
    default:
      return role
  }
}

function isReactNode(v: unknown): v is ReactNode {
  if (v === null || v === undefined) return true
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true
  if (Array.isArray(v)) return true
  if (typeof v === 'object' && '$$typeof' in (v as object)) return true
  return false
}
