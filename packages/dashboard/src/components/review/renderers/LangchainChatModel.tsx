/**
 * LangchainChatModel — renderer for `langchain.chat_model`
 * (Python) and `langchain.chat.<runnable-id>` (TS).
 *
 * Returns `{input, output}` for side-by-side layout. Input pane
 * shows the request messages (per batch when batch_size > 1);
 * output pane shows the generated assistant message(s).
 *
 * Collapse defaults follow the dashboard convention:
 *   - System → collapsed.
 *   - User → collapsed except the LAST user message in the batch.
 *   - Assistant (in the input as conversation history) → open.
 *   - Output completions → open.
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import { Message, type MessageRole } from '../Message'
import type { Renderer } from '../types'
import { summariseContent } from '../summarise'
import { ClickableImage } from '../ClickableMedia'

export const LangchainChatModelRenderer: Renderer = ({ input, output }) => {
  const batches = extractInputBatches(input)
  const generations = extractGenerations(output)

  const inputPane = (
    <div className="space-y-3">
      {batches.map((batch, b) => (
        <section key={`in-batch-${b}`} className="space-y-2">
          {batches.length > 1 && (
            <h5 className="text-[10px] uppercase tracking-wide text-text-muted">
              Batch {b + 1} of {batches.length}
            </h5>
          )}
          {batch.map((m, i) => (
            <LcMessageView
              key={i}
              msg={m}
              initiallyOpen={i === batch.length - 1}
            />
          ))}
        </section>
      ))}
    </div>
  )

  const outputPane = (
    <div className="space-y-3">
      {generations.map((batch, b) => (
        <section key={`out-batch-${b}`} className="space-y-2">
          {generations.length > 1 && (
            <h5 className="text-[10px] uppercase tracking-wide text-text-muted">
              Batch {b + 1} of {generations.length}
            </h5>
          )}
          {batch.map((c, i) => (
            <LcMessageView
              key={i}
              msg={c.message}
              initiallyOpen
              caption={
                batch.length > 1
                  ? `completion ${i + 1} of ${batch.length}${c.finish_reason ? ` · ${c.finish_reason}` : ''}`
                  : c.finish_reason && c.finish_reason !== 'stop'
                    ? `finish: ${c.finish_reason}`
                    : undefined
              }
            />
          ))}
        </section>
      ))}
    </div>
  )

  return { input: inputPane, output: outputPane }
}

// ---- extraction ----

interface ChatGeneration {
  text: string | null
  finish_reason: string | null
  message: unknown
}

function extractInputBatches(input: unknown): unknown[][] {
  if (!isPlainObject(input)) return []
  const messages = input.messages
  if (!Array.isArray(messages)) return []
  return messages.map((batch) => (Array.isArray(batch) ? batch : [batch]))
}

function extractGenerations(output: unknown): ChatGeneration[][] {
  if (!isPlainObject(output)) return []
  const generations = output.generations
  if (!Array.isArray(generations)) return []
  return generations.map((batch) => {
    if (!Array.isArray(batch)) return []
    return batch.map((g) => normaliseGeneration(g))
  })
}

function normaliseGeneration(raw: unknown): ChatGeneration {
  if (!isPlainObject(raw)) {
    return { text: null, finish_reason: null, message: raw }
  }
  const text = typeof raw.text === 'string' ? raw.text : null
  const message = 'message' in raw ? raw.message : null
  const genInfo = isPlainObject(raw.generation_info) ? raw.generation_info : null
  const finish_reason =
    genInfo && typeof genInfo.finish_reason === 'string' ? genInfo.finish_reason : null
  return { text, finish_reason, message }
}

// ---- LC message view (shared with LangchainChain) ----

export function LcMessageView({
  msg,
  initiallyOpen = true,
  caption,
}: {
  msg: unknown
  initiallyOpen?: boolean
  caption?: string
}): ReactNode {
  if (!isPlainObject(msg)) {
    return (
      <Message
        role="unknown"
        initiallyOpen={initiallyOpen}
        summary={summariseContent(msg)}
        caption={caption}
        content={<HumanValue value={msg} />}
      />
    )
  }

  const rawRole =
    typeof msg.role === 'string'
      ? msg.role
      : typeof msg.type === 'string'
        ? msg.type
        : 'unknown'
  const role = lcRoleToMessage(rawRole)
  const toolCalls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]) : null
  const additional = isPlainObject(msg.additional_kwargs) ? msg.additional_kwargs : null
  const parsed = additional && 'parsed' in additional ? additional.parsed : null
  // When structured output is present (`additional_kwargs.parsed`),
  // the raw `content` is just the JSON-encoded form of the same
  // value. Render the structured value alone — never show both, and
  // never surface the raw JSON string.
  const content = parsed !== null && parsed !== undefined ? parsed : msg.content

  const captions: string[] = []
  if (caption) captions.push(caption)
  if (typeof msg.name === 'string' && msg.name.length > 0) captions.push(`name: ${msg.name}`)
  if (typeof msg.tool_call_id === 'string') captions.push(`for: ${msg.tool_call_id}`)
  const respMeta = isPlainObject(msg.response_metadata) ? msg.response_metadata : null
  const finish =
    respMeta && typeof respMeta.finish_reason === 'string' ? respMeta.finish_reason : null
  if (finish) captions.push(`finish: ${finish}`)

  const summaryParts: string[] = []
  if (toolCalls && toolCalls.length > 0) {
    const first = toolCalls[0]
    const name = isPlainObject(first) && typeof first.name === 'string' ? first.name : null
    summaryParts.push(name ? `tool call: ${name}` : 'tool call')
  }
  const baseSummary = summariseContent(content)
  if (baseSummary !== '(empty)' && baseSummary !== '(structured)') {
    summaryParts.unshift(baseSummary)
  }

  return (
    <Message
      role={role}
      initiallyOpen={initiallyOpen}
      summary={summaryParts.join(' · ') || baseSummary}
      caption={captions.length > 0 ? captions.join(' · ') : undefined}
      content={
        <div className="space-y-2 text-sm">
          {renderContent(content)}
          {toolCalls && toolCalls.length > 0 && (
            <div className="space-y-1">
              {toolCalls.map((tc, i) => (
                <LcToolCallBlock key={i} call={tc} />
              ))}
            </div>
          )}
        </div>
      }
    />
  )
}

export function lcRoleOf(msg: unknown): MessageRole {
  if (!isPlainObject(msg)) return 'unknown'
  const t = typeof msg.role === 'string' ? msg.role : typeof msg.type === 'string' ? msg.type : ''
  return lcRoleToMessage(t)
}

function lcRoleToMessage(t: string): MessageRole {
  switch (t) {
    case 'human':
    case 'user':
      return 'user'
    case 'ai':
    case 'assistant':
      return 'assistant'
    case 'system':
      return 'system'
    case 'developer':
      return 'developer'
    case 'tool':
      return 'tool'
    case 'function':
      return 'function'
    default:
      return 'unknown'
  }
}

function renderContent(content: unknown): ReactNode {
  if (content === null || content === undefined) return null
  if (typeof content === 'string') {
    if (content.length === 0) return null
    // Structured-output content arrives as a JSON-encoded string. If
    // the whole string parses as JSON object/array, render the
    // structured value instead of dumping the raw text.
    const parsed = tryParseJson(content)
    if (
      parsed !== content &&
      (Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object'))
    ) {
      return <HumanValue value={parsed} />
    }
    return <p className="whitespace-pre-wrap break-words">{content}</p>
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2">
        {content.map((part, i) => (
          <LcContentPart key={i} part={part} />
        ))}
      </div>
    )
  }
  return <HumanValue value={content} />
}

function tryParseJson(s: string): unknown {
  const trimmed = s.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return s
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

function LcContentPart({ part }: { part: unknown }): ReactNode {
  if (!isPlainObject(part)) return <HumanValue value={part} />
  const type = typeof part.type === 'string' ? part.type : null
  switch (type) {
    case 'text':
      return (
        <p className="whitespace-pre-wrap break-words">
          {typeof part.text === 'string' ? part.text : <HumanValue value={part} />}
        </p>
      )
    case 'image': {
      const url = typeof part.url === 'string' ? part.url : null
      const base64 = typeof part.base64 === 'string' ? part.base64 : null
      const mime = typeof part.mime_type === 'string' ? part.mime_type : 'image/png'
      if (url)
        return <ClickableImage src={url} alt="image" className="max-h-48 max-w-xs" />
      if (base64)
        return (
          <ClickableImage
            src={`data:${mime};base64,${base64}`}
            alt="image"
            className="max-h-48 max-w-xs"
          />
        )
      return <HumanValue value={part} />
    }
    case 'image_url': {
      const inner = isPlainObject(part.image_url) ? part.image_url : null
      const url = inner && typeof inner.url === 'string' ? inner.url : null
      if (!url) return <HumanValue value={part} />
      return <ClickableImage src={url} alt="image" className="max-h-48 max-w-xs" />
    }
    default:
      return <HumanValue value={part} />
  }
}

function LcToolCallBlock({ call }: { call: unknown }): ReactNode {
  if (!isPlainObject(call)) return <HumanValue value={call} />
  const name = typeof call.name === 'string' ? call.name : null
  const id = typeof call.id === 'string' ? call.id : null
  const args = 'args' in call ? call.args : 'input' in call ? call.input : null
  return (
    <div className="rounded border border-forest/30 bg-forest/5 p-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-forest/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-forest">
          Tool call
        </span>
        {name && <span className="font-mono text-[11px] font-medium">{name}</span>}
        {id && <span className="font-mono text-[10px] text-text-muted">{id}</span>}
      </div>
      {args !== null && args !== undefined && (
        <div className="mt-1.5">
          <HumanValue value={args} />
        </div>
      )}
    </div>
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
