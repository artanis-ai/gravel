/**
 * LangchainChain — renderer for `langchain.chain` (Python) and
 * `langchain.chain.<runnable-id>` (TS).
 *
 * Returns `{input, output}` for side-by-side layout. LC chains are
 * open-shape — `inputs` can be a message list, a single LC
 * message, a `{vars+messages}` dict, or arbitrary primitives — so
 * the renderer applies heuristics per the fixture catalogue.
 *
 * Five real-world variants pinned by fixtures:
 *   1. `inputs: {messages: [...LCMessage]}` → render as chat
 *   2. `inputs: <single LCMessage dict>` → one bubble
 *   3. `inputs: [list of mixed entries]` → render each
 *   4. `inputs: {var1, ..., messages: [...]}` → vars chip strip +
 *      chat
 *   5. `inputs: {key: <primitive>}` → labelled chips only
 *
 * Collapse defaults: system → closed, user → closed except last,
 * assistant / unknown → open. Top-level vars + structured-output
 * chips don't collapse.
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import { humaniseKey } from '../../../lib/humanise'
import { LcMessageView } from './LangchainChatModel'
import type { Renderer } from '../types'

export const LangchainChainRenderer: Renderer = ({ input, output }) => ({
  input: renderInput(input),
  output: renderOutput(output, extractInputMessages(input)),
})

/** Pull the messages array out of the chain's input envelope (if any)
 *  so the output renderer can subtract them when the chain echoes the
 *  full conversation back. */
function extractInputMessages(input: unknown): unknown[] | null {
  const inner = unwrapCallbackEnvelope(input)
  if (Array.isArray(inner)) return inner
  if (isPlainObject(inner) && Array.isArray(inner.messages)) return inner.messages
  return null
}

// ---- input rendering ----

function renderInput(input: unknown): ReactNode {
  const inner = unwrapCallbackEnvelope(input)

  if (inner === null || inner === undefined) {
    return <HumanValue value={inner} />
  }

  if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') {
    return <HumanValue value={inner} />
  }

  if (Array.isArray(inner)) {
    return (
      <div className="space-y-2">
        {inner.map((entry, i) => (
          <LcMessageView
            key={i}
            msg={entry}
            initiallyOpen={i === inner.length - 1}
          />
        ))}
      </div>
    )
  }

  if (isLcMessage(inner)) {
    return <LcMessageView msg={inner} initiallyOpen />
  }

  if (isPlainObject(inner)) {
    const messagesField = 'messages' in inner ? inner.messages : null
    const otherEntries: Array<[string, unknown]> = []
    for (const [k, v] of Object.entries(inner)) {
      if (k === 'messages') continue
      otherEntries.push([k, v])
    }

    let chat: ReactNode = null
    if (Array.isArray(messagesField) && messagesField.length > 0) {
      chat = (
        <div className="space-y-2">
          {messagesField.map((m, i) => (
            <LcMessageView
              key={i}
              msg={m}
              initiallyOpen={i === messagesField.length - 1}
            />
          ))}
        </div>
      )
    }

    return (
      <div className="space-y-2">
        {otherEntries.length > 0 && <VarsStrip entries={otherEntries} />}
        {chat}
        {!Array.isArray(messagesField) && otherEntries.length === 0 && (
          <HumanValue value={inner} />
        )}
      </div>
    )
  }

  return <HumanValue value={inner} />
}

function unwrapCallbackEnvelope(input: unknown): unknown {
  if (!isPlainObject(input)) return input
  if (
    'inputs' in input &&
    Object.keys(input).every((k) => k === 'inputs' || k === 'serialized')
  ) {
    return input.inputs
  }
  return input
}

function VarsStrip({ entries }: { entries: Array<[string, unknown]> }): ReactNode {
  return (
    <div>
      <h5 className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">Variables</h5>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => (
          <span
            key={k}
            className="inline-flex max-w-md items-baseline gap-1.5 rounded border border-warm bg-warm/30 px-2 py-1 text-xs"
          >
            <span className="font-medium text-text-muted">{humaniseKey(k)}</span>
            <span className="min-w-0 break-words text-text-dark">
              <HumanValue value={v} />
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ---- output rendering ----

function renderOutput(output: unknown, inputMessages: unknown[] | null): ReactNode {
  if (output === null || output === undefined) {
    return <span className="text-text-muted italic">no output</span>
  }

  if (typeof output === 'string' || typeof output === 'number' || typeof output === 'boolean') {
    return <HumanValue value={output} />
  }

  if (Array.isArray(output)) {
    const novel = subtractEchoedMessages(output, inputMessages)
    return (
      <div className="space-y-2">
        {novel.map((entry, i) => (
          <LcMessageView
            key={i}
            msg={entry}
            initiallyOpen={i === novel.length - 1}
          />
        ))}
      </div>
    )
  }

  if (isLcMessage(output)) {
    return <LcMessageView msg={output} initiallyOpen />
  }

  if (isPlainObject(output)) {
    if (Array.isArray(output.messages) && output.messages.length > 0) {
      // Chains using `RunnableWithMessageHistory` (and friends) return
      // the FULL conversation including the input. Strip the echoed
      // prefix so the output pane shows only the new turn(s).
      const novel = subtractEchoedMessages(output.messages, inputMessages)
      if (novel.length === 0) {
        return <span className="text-text-muted italic">no new messages</span>
      }
      return (
        <div className="space-y-2">
          {novel.map((m, i) => (
            <LcMessageView
              key={i}
              msg={m}
              initiallyOpen={i === novel.length - 1}
            />
          ))}
        </div>
      )
    }

    const entries = Object.entries(output)
    if (entries.length === 1) {
      const [k, v] = entries[0]!
      if (isPrimitive(v)) {
        return <ValueChip label={humaniseKey(k)} value={v} />
      }
    }

    if (entries.every(([_, v]) => isPrimitive(v))) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {entries.map(([k, v]) => (
            <ValueChip key={k} label={humaniseKey(k)} value={v} />
          ))}
        </div>
      )
    }

    return <HumanValue value={output} />
  }

  return <HumanValue value={output} />
}

function ValueChip({ label, value }: { label: string; value: unknown }): ReactNode {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded border border-forest/30 bg-forest/5 px-2 py-1 text-sm">
      <span className="text-[11px] uppercase tracking-wide text-text-muted">{label}</span>
      <span className="font-medium text-text-dark">
        <HumanValue value={value} />
      </span>
    </span>
  )
}

// ---- helpers ----

/** If the output's message list begins with the same role/content
 *  prefix as the input's message list, drop that prefix so only new
 *  messages appear in the output pane. Compares by role + content
 *  text — not by id, since LC often regenerates ids when echoing. */
function subtractEchoedMessages(
  output: unknown[],
  input: unknown[] | null,
): unknown[] {
  if (!input || input.length === 0) return output
  let matched = 0
  const limit = Math.min(output.length, input.length)
  for (let i = 0; i < limit; i++) {
    if (sameMessage(output[i], input[i])) matched++
    else break
  }
  if (matched === 0) return output
  return output.slice(matched)
}

function sameMessage(a: unknown, b: unknown): boolean {
  return roleOf(a) === roleOf(b) && contentTextOf(a) === contentTextOf(b)
}

function roleOf(m: unknown): string {
  if (!isPlainObject(m)) return ''
  const raw = typeof m.role === 'string' ? m.role : typeof m.type === 'string' ? m.type : ''
  // LC uses `type: 'human'|'ai'` while OpenAI-style inputs use
  // `role: 'user'|'assistant'`. Normalise so the same logical role
  // matches across both naming conventions when subtracting echoed
  // messages.
  switch (raw) {
    case 'human':
      return 'user'
    case 'ai':
      return 'assistant'
    default:
      return raw
  }
}

function contentTextOf(m: unknown): string {
  if (!isPlainObject(m)) return ''
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === 'string') return part
        if (isPlainObject(part) && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return ''
}

function isLcMessage(v: unknown): boolean {
  if (!isPlainObject(v)) return false
  if (typeof v.type === 'string') {
    const t = v.type
    if (
      t === 'human' ||
      t === 'ai' ||
      t === 'system' ||
      t === 'tool' ||
      t === 'function' ||
      t === 'chat'
    ) {
      return true
    }
  }
  return false
}

function isPrimitive(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
