/**
 * OpenAIChat — renderer for `openai.chat.completions.create`.
 *
 * Returns `{input, output}` so the ReviewSurface can lay it out
 * side by side (the dashboard's long-standing Input/Output
 * convention).
 *
 * Covered shapes (each pinned by a fixture):
 *   - Plain user / system / assistant text
 *   - Multimodal user content parts: `text`, `image_url`,
 *     `input_audio`, `file`
 *   - Assistant `tool_calls` (function-style, JSON-string `arguments`)
 *   - `role: 'tool'` follow-up with `tool_call_id`
 *   - `message.refusal` distinct from regular content
 *   - Multi-choice outputs (`n > 1`)
 *   - Streaming with chunks observed under `metadata.states`
 *     (chrome surfaces the stream observability; the renderer
 *     just shows the assembled output)
 *   - Erroring samples (null `output` + `metadata.error`) — the
 *     ReviewSurface paints the error banner; this renderer
 *     gracefully skips the assistant turn.
 *
 * Collapse defaults follow the dashboard convention:
 *   - Single message → open.
 *   - `system` / `developer` → collapsed.
 *   - `user` → collapsed except the LAST user message.
 *   - `assistant` / `tool` / `function` → open.
 *   - Output choices → always open.
 *
 * Anything not recognised falls through to `HumanValue`. We never
 * dump JSON.
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import { Message } from '../Message'
import type { Renderer } from '../types'
import { summariseContent } from '../summarise'
import { ClickableImage } from '../ClickableMedia'

export const OpenAIChatRenderer: Renderer = ({ input, output }) => {
  const inputMessages = extractInputMessages(input)
  const choices = extractChoices(output)
  const tools = extractTools(input)

  const inputPane = (
    <div className="space-y-2">
      {inputMessages.map((m, i) => (
        <ChatMessageView
          key={`in-${i}`}
          msg={m}
          initiallyOpen={i === inputMessages.length - 1}
        />
      ))}
      {tools.length > 0 && (
        <div className="rounded border border-warm bg-warm/10 p-3 text-xs">
          <ToolsSection tools={tools} />
        </div>
      )}
    </div>
  )

  const outputPane =
    choices.length === 0 ? null : (
      <div className="space-y-2">
        {choices.map((c, i) => (
          <ChatMessageView
            key={`choice-${i}`}
            msg={c.message}
            initiallyOpen
            caption={
              choices.length > 1
                ? `choice ${i + 1} of ${choices.length}${c.finish_reason ? ` · ${c.finish_reason}` : ''}`
                : c.finish_reason && c.finish_reason !== 'stop'
                  ? `finish: ${c.finish_reason}`
                  : undefined
            }
          />
        ))}
      </div>
    )

  return { input: inputPane, output: outputPane }
}

// ---- extraction ----

interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function' | 'unknown'
  content: unknown
  name?: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
  refusal?: string | null
  audio?: { id?: string; transcript?: string; data?: string; expires_at?: number }
  finish_reason?: string | null
}

interface ToolCall {
  id?: string
  name?: string
  arguments?: unknown
}

interface Choice {
  index: number
  message: ChatMessage
  finish_reason: string | null
}

function extractInputMessages(input: unknown): ChatMessage[] {
  if (!isPlainObject(input)) return []
  const messages = input.messages
  if (!Array.isArray(messages)) return []
  return messages.map((m) => normaliseMessage(m))
}

function extractChoices(output: unknown): Choice[] {
  if (!isPlainObject(output)) return []
  if (Array.isArray(output.chunks) && !Array.isArray(output.choices)) {
    return assembleStreamedChoices(output.chunks)
  }
  const choices = output.choices
  if (!Array.isArray(choices)) return []
  return choices.map((c, i) => ({
    index: isPlainObject(c) && typeof c.index === 'number' ? c.index : i,
    message: isPlainObject(c) ? normaliseMessage(c.message) : normaliseMessage(null),
    finish_reason:
      isPlainObject(c) && typeof c.finish_reason === 'string' ? c.finish_reason : null,
  }))
}

function assembleStreamedChoices(chunks: unknown[]): Choice[] {
  const choices = new Map<number, AssembledChoice>()
  for (const chunk of chunks) {
    if (!isPlainObject(chunk)) continue
    const chunkChoices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (let i = 0; i < chunkChoices.length; i++) {
      const c = chunkChoices[i]
      if (!isPlainObject(c)) continue
      const index = typeof c.index === 'number' ? c.index : i
      const slot = choices.get(index) ?? {
        index,
        content: '',
        role: 'assistant',
        toolCalls: new Map<number, AssembledToolCall>(),
        finish_reason: null,
        refusal: null,
      }
      const delta = isPlainObject(c.delta) ? c.delta : null
      if (delta) {
        if (typeof delta.role === 'string') slot.role = delta.role
        if (typeof delta.content === 'string') slot.content += delta.content
        if (typeof delta.refusal === 'string')
          slot.refusal = (slot.refusal ?? '') + delta.refusal
        if (Array.isArray(delta.tool_calls)) {
          for (let ti = 0; ti < delta.tool_calls.length; ti++) {
            const tc = delta.tool_calls[ti]
            if (!isPlainObject(tc)) continue
            const tcIndex = typeof tc.index === 'number' ? tc.index : ti
            const tcSlot = slot.toolCalls.get(tcIndex) ?? {
              id: null,
              name: null,
              argumentsRaw: '',
            }
            if (typeof tc.id === 'string') tcSlot.id = tc.id
            const fn = isPlainObject(tc.function) ? tc.function : null
            if (fn) {
              if (typeof fn.name === 'string') tcSlot.name = fn.name
              if (typeof fn.arguments === 'string') tcSlot.argumentsRaw += fn.arguments
            }
            slot.toolCalls.set(tcIndex, tcSlot)
          }
        }
      }
      if (typeof c.finish_reason === 'string') slot.finish_reason = c.finish_reason
      choices.set(index, slot)
    }
  }
  return Array.from(choices.values())
    .sort((a, b) => a.index - b.index)
    .map((s) => ({
      index: s.index,
      finish_reason: s.finish_reason,
      message: {
        role: roleFromString(s.role),
        content: s.content,
        refusal: s.refusal,
        tool_calls:
          s.toolCalls.size > 0
            ? Array.from(s.toolCalls.values()).map((tc) => ({
                id: tc.id ?? undefined,
                name: tc.name ?? undefined,
                arguments: parseJsonString(tc.argumentsRaw),
              }))
            : undefined,
      },
    }))
}

interface AssembledChoice {
  index: number
  content: string
  role: string
  toolCalls: Map<number, AssembledToolCall>
  finish_reason: string | null
  refusal: string | null
}

interface AssembledToolCall {
  id: string | null
  name: string | null
  argumentsRaw: string
}

function extractTools(input: unknown): unknown[] {
  if (!isPlainObject(input)) return []
  return Array.isArray(input.tools) ? input.tools : []
}

function normaliseMessage(raw: unknown): ChatMessage {
  if (!isPlainObject(raw)) {
    return { role: 'unknown', content: raw }
  }
  const role = typeof raw.role === 'string' ? raw.role : 'unknown'
  const out: ChatMessage = {
    role: role as ChatMessage['role'],
    content: 'content' in raw ? raw.content : null,
  }
  if (typeof raw.name === 'string') out.name = raw.name
  if (typeof raw.tool_call_id === 'string') out.tool_call_id = raw.tool_call_id
  if (Array.isArray(raw.tool_calls)) {
    out.tool_calls = raw.tool_calls.map((tc) => normaliseToolCall(tc))
  }
  if ('refusal' in raw && typeof raw.refusal !== 'undefined') {
    out.refusal = typeof raw.refusal === 'string' ? raw.refusal : null
  }
  if (isPlainObject(raw.audio)) {
    out.audio = raw.audio as ChatMessage['audio']
  }
  return out
}

function normaliseToolCall(raw: unknown): ToolCall {
  if (!isPlainObject(raw)) return {}
  const fn = isPlainObject(raw.function) ? raw.function : null
  const argsRaw = fn && 'arguments' in fn ? fn.arguments : undefined
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    name: fn && typeof fn.name === 'string' ? fn.name : undefined,
    arguments: parseJsonString(argsRaw),
  }
}

function parseJsonString(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const trimmed = v.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

// ---- views ----

function ChatMessageView({
  msg,
  initiallyOpen,
  caption,
}: {
  msg: ChatMessage
  initiallyOpen: boolean
  caption?: string
}): ReactNode {
  const captions: string[] = []
  if (caption) captions.push(caption)
  if (msg.name) captions.push(`name: ${msg.name}`)
  if (msg.tool_call_id) captions.push(`for: ${msg.tool_call_id}`)
  if (msg.finish_reason) captions.push(`finish: ${msg.finish_reason}`)

  const content =
    msg.role === 'tool' || msg.role === 'function'
      ? parseJsonString(msg.content)
      : msg.content

  return (
    <Message
      role={roleFromString(msg.role)}
      initiallyOpen={initiallyOpen}
      summary={summariseChatMessage(msg)}
      caption={captions.length > 0 ? captions.join(' · ') : undefined}
      content={
        <div className="space-y-2 text-sm">
          {msg.refusal && (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-xs">
              <span className="mr-2 font-medium uppercase tracking-wide text-red-700">
                Refusal
              </span>
              <span className="text-red-900">{msg.refusal}</span>
            </div>
          )}
          {renderContent(content)}
          {msg.tool_calls && msg.tool_calls.length > 0 && (
            <div className="space-y-1">
              {msg.tool_calls.map((tc, i) => (
                <ToolCallBlock key={tc.id ?? i} call={tc} />
              ))}
            </div>
          )}
          {msg.audio && (
            <div className="rounded border border-warm bg-warm/30 p-2 text-xs">
              <span className="mr-2 font-medium uppercase tracking-wide text-text-muted">
                Audio
              </span>
              {msg.audio.transcript && (
                <span className="block whitespace-pre-wrap">{msg.audio.transcript}</span>
              )}
              {msg.audio.id && (
                <span className="block font-mono text-[10px] text-text-muted">
                  id: {msg.audio.id}
                </span>
              )}
            </div>
          )}
        </div>
      }
    />
  )
}

function summariseChatMessage(msg: ChatMessage): string {
  if (msg.refusal) return `refusal: ${msg.refusal.slice(0, 70)}`
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const first = msg.tool_calls[0]!
    return first.name ? `tool call: ${first.name}` : 'tool call'
  }
  return summariseContent(msg.content)
}

function ToolCallBlock({ call }: { call: ToolCall }): ReactNode {
  return (
    <div className="rounded border border-forest/30 bg-forest/5 p-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-forest/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-forest">
          Tool call
        </span>
        {call.name && <span className="font-mono text-[11px] font-medium">{call.name}</span>}
        {call.id && <span className="font-mono text-[10px] text-text-muted">{call.id}</span>}
      </div>
      {call.arguments !== undefined && call.arguments !== null && (
        <div className="mt-1.5">
          <HumanValue value={call.arguments} />
        </div>
      )}
    </div>
  )
}

function renderContent(content: unknown): ReactNode {
  if (content === null || content === undefined) return null
  if (typeof content === 'string') {
    if (content.length === 0) return null
    // When the model produces structured output via
    // `response_format: {type: 'json_object'}` or `'json_schema'`,
    // the assistant message content is a JSON-encoded string. Render
    // the structured value, not the raw JSON text.
    const parsed = parseJsonString(content)
    if (parsed !== content && (Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object'))) {
      return <HumanValue value={parsed} />
    }
    return <p className="whitespace-pre-wrap break-words">{content}</p>
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2">
        {content.map((part, i) => (
          <ContentPartView key={i} part={part} />
        ))}
      </div>
    )
  }
  return <HumanValue value={content} />
}

function ContentPartView({ part }: { part: unknown }): ReactNode {
  if (!isPlainObject(part)) return <HumanValue value={part} />
  const type = typeof part.type === 'string' ? part.type : null
  switch (type) {
    case 'text':
    case 'output_text':
      return (
        <p className="whitespace-pre-wrap break-words">
          {typeof part.text === 'string' ? part.text : <HumanValue value={part} />}
        </p>
      )
    case 'image_url': {
      const url =
        isPlainObject(part.image_url) && typeof part.image_url.url === 'string'
          ? part.image_url.url
          : null
      if (!url) return <HumanValue value={part} />
      const detail =
        isPlainObject(part.image_url) && typeof part.image_url.detail === 'string'
          ? part.image_url.detail
          : null
      return (
        <span className="inline-flex items-start gap-2">
          <ClickableImage
            src={url}
            alt="image attachment"
            className="max-h-32 max-w-xs"
          />
          {detail && <span className="text-[10px] text-text-muted">detail: {detail}</span>}
        </span>
      )
    }
    case 'input_audio': {
      const audio = isPlainObject(part.input_audio) ? part.input_audio : null
      const data = audio && typeof audio.data === 'string' ? audio.data : null
      const format = audio && typeof audio.format === 'string' ? audio.format : null
      return (
        <span className="inline-flex items-baseline gap-2 text-xs">
          <span className="font-medium uppercase tracking-wide text-text-muted">Audio</span>
          {data ? (
            <audio
              controls
              src={
                data.startsWith('data:')
                  ? data
                  : `data:audio/${format ?? 'wav'};base64,${data}`
              }
              className="h-8 max-w-xs"
            />
          ) : (
            <HumanValue value={part} />
          )}
        </span>
      )
    }
    case 'file': {
      const file = isPlainObject(part.file) ? part.file : null
      return (
        <span className="inline-flex items-baseline gap-2 rounded bg-warm/40 px-2 py-1 text-xs">
          <span className="font-medium uppercase tracking-wide text-text-muted">File</span>
          {file ? <HumanValue value={file} /> : <HumanValue value={part} />}
        </span>
      )
    }
    case 'refusal': {
      return (
        <span className="block rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900">
          <span className="mr-2 font-medium uppercase tracking-wide text-red-700">
            Refusal
          </span>
          {typeof part.refusal === 'string' ? part.refusal : <HumanValue value={part} />}
        </span>
      )
    }
    default:
      return <HumanValue value={part} />
  }
}

function ToolsSection({ tools }: { tools: unknown[] }): ReactNode {
  return (
    <div>
      <h5 className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">
        Tools ({tools.length})
      </h5>
      <div className="space-y-1.5">
        {tools.map((t, i) => (
          <ToolDef key={i} tool={t} />
        ))}
      </div>
    </div>
  )
}

function ToolDef({ tool }: { tool: unknown }): ReactNode {
  if (!isPlainObject(tool)) return <HumanValue value={tool} />
  const fn = isPlainObject(tool.function) ? tool.function : null
  const name = fn && typeof fn.name === 'string' ? fn.name : null
  const description = fn && typeof fn.description === 'string' ? fn.description : null
  const parameters = fn && 'parameters' in fn ? fn.parameters : null
  if (!name) return <HumanValue value={tool} />
  return (
    <div className="rounded border border-warm bg-white px-2 py-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[11px] font-medium text-forest">{name}</span>
        {description && <span className="text-[11px] text-text-muted">{description}</span>}
      </div>
      {parameters !== null && parameters !== undefined && (
        <div className="mt-1 text-[11px]">
          <HumanValue value={parameters} />
        </div>
      )}
    </div>
  )
}

function roleFromString(role: string): MessageRoleOut {
  switch (role) {
    case 'system':
    case 'developer':
    case 'user':
    case 'assistant':
    case 'tool':
    case 'function':
      return role
    default:
      return 'unknown'
  }
}

type MessageRoleOut =
  | 'system'
  | 'developer'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'function'
  | 'unknown'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
