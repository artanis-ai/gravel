/**
 * Shape-aware renderer for sample input/output payloads.
 *
 * Detects common LLM-call shapes (OpenAI chat completions, Anthropic
 * Messages, plain string, tool-calls, raw JSON) and renders them with
 * structure — message bubbles for chat, a typed list for tool calls,
 * etc — instead of dumping a JSON pre-block. Falls back to JSON when
 * we can't recognise the shape.
 *
 * Detection is intentionally conservative: false negatives (fallback
 * to JSON) are fine, false positives (mis-detecting) are user-hostile.
 * The rules below were picked from the actual provider patches in
 * sdk-ts/src/tracing/{openai,anthropic,langchain}.ts so we render
 * exactly what they captured.
 */
import type { ReactNode } from 'react'

type Detected =
  | { kind: 'chat-input'; system: string | null; messages: Array<{ role: string; content: string }>; model?: string }
  | { kind: 'chat-output'; role: string; content: string; finishReason?: string; toolCalls?: ToolCall[] }
  | { kind: 'string'; text: string }
  | { kind: 'tool-calls'; calls: ToolCall[] }
  | { kind: 'unknown' }

interface ToolCall {
  name: string
  args: unknown
  id?: string
}

export function PayloadShape({ value }: { value: unknown }): ReactNode {
  const detected = detect(value)
  switch (detected.kind) {
    case 'chat-input':
      return <ChatTranscript system={detected.system} messages={detected.messages} model={detected.model} />
    case 'chat-output':
      return (
        <CompletionView
          role={detected.role}
          content={detected.content}
          finishReason={detected.finishReason}
          toolCalls={detected.toolCalls}
        />
      )
    case 'string':
      return <StringView text={detected.text} />
    case 'tool-calls':
      return <ToolCallsView calls={detected.calls} />
    default:
      return <RawJson value={value} />
  }
}

function detect(value: unknown): Detected {
  if (value == null) return { kind: 'unknown' }
  if (typeof value === 'string') return { kind: 'string', text: value }

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>

    // OpenAI / Anthropic chat input: { messages: [...], system?, model? }
    if (Array.isArray(v.messages)) {
      const system = typeof v.system === 'string' ? v.system : null
      const messages = (v.messages as unknown[])
        .map(toMessage)
        .filter((m): m is { role: string; content: string } => m !== null)
      if (messages.length > 0) {
        return { kind: 'chat-input', system, messages, model: typeof v.model === 'string' ? v.model : undefined }
      }
    }

    // OpenAI chat completion output: { choices: [{ message: { role, content, tool_calls? }, finish_reason }] }
    if (Array.isArray(v.choices) && v.choices.length > 0) {
      const first = v.choices[0] as { message?: unknown; finish_reason?: unknown } | undefined
      const msg = first?.message as { role?: unknown; content?: unknown; tool_calls?: unknown } | undefined
      if (msg && typeof msg === 'object') {
        const role = typeof msg.role === 'string' ? msg.role : 'assistant'
        const content = typeof msg.content === 'string' ? msg.content : ''
        const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : undefined
        const toolCalls = parseOpenAiToolCalls(msg.tool_calls)
        return { kind: 'chat-output', role, content, finishReason, toolCalls }
      }
    }

    // Anthropic Messages output: { content: [{ type: 'text' | 'tool_use', text?, name?, input? }], stop_reason }
    if (Array.isArray(v.content) && (v.content as unknown[]).every((b) => typeof b === 'object' && b !== null)) {
      const blocks = v.content as Array<Record<string, unknown>>
      const texts = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
      const tools = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b): ToolCall => ({
          name: String(b.name ?? 'tool'),
          args: b.input,
          id: typeof b.id === 'string' ? b.id : undefined,
        }))
      if (texts.length > 0 || tools.length > 0) {
        return {
          kind: 'chat-output',
          role: typeof v.role === 'string' ? v.role : 'assistant',
          content: texts.join('\n\n'),
          finishReason: typeof v.stop_reason === 'string' ? v.stop_reason : undefined,
          toolCalls: tools.length > 0 ? tools : undefined,
        }
      }
    }

    // Anthropic short-output: { content: "string", role }
    if (typeof v.content === 'string') {
      return {
        kind: 'chat-output',
        role: typeof v.role === 'string' ? v.role : 'assistant',
        content: v.content,
      }
    }

    // Bare tool-calls payload.
    const tc = parseOpenAiToolCalls(v.tool_calls)
    if (tc) return { kind: 'tool-calls', calls: tc }
  }

  return { kind: 'unknown' }
}

function toMessage(raw: unknown): { role: string; content: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const role = typeof m.role === 'string' ? m.role : null
  if (!role) return null
  let content: string
  if (typeof m.content === 'string') {
    content = m.content
  } else if (Array.isArray(m.content)) {
    // Anthropic-style array of text/tool_use blocks
    const parts = (m.content as unknown[])
      .map((b) => {
        if (typeof b === 'string') return b
        if (typeof b === 'object' && b !== null) {
          const block = b as Record<string, unknown>
          if (typeof block.text === 'string') return block.text
          if (block.type === 'tool_use') return `[tool: ${String(block.name ?? '?')}]`
          if (block.type === 'tool_result') return `[tool result]`
        }
        return ''
      })
      .filter(Boolean)
    content = parts.join('\n')
  } else {
    content = ''
  }
  return { role, content }
}

function parseOpenAiToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls = value
    .map((raw): ToolCall | null => {
      if (typeof raw !== 'object' || raw === null) return null
      const t = raw as Record<string, unknown>
      const fn = t.function as Record<string, unknown> | undefined
      if (!fn || typeof fn.name !== 'string') return null
      let args: unknown = fn.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          /* leave as raw string */
        }
      }
      return { name: fn.name, args, id: typeof t.id === 'string' ? t.id : undefined }
    })
    .filter((c): c is ToolCall => c !== null)
  return calls.length > 0 ? calls : undefined
}

// --- views ---

function ChatTranscript({
  system,
  messages,
  model,
}: {
  system: string | null
  messages: Array<{ role: string; content: string }>
  model?: string
}) {
  return (
    <div className="space-y-2">
      {model && <div className="text-xs text-text-muted">model: <code className="font-mono">{model}</code></div>}
      {system && <Bubble role="system" content={system} />}
      {messages.map((m, i) => (
        <Bubble key={i} role={m.role} content={m.content} />
      ))}
    </div>
  )
}

function CompletionView({
  role,
  content,
  finishReason,
  toolCalls,
}: {
  role: string
  content: string
  finishReason?: string
  toolCalls?: ToolCall[]
}) {
  return (
    <div className="space-y-2">
      {content && <Bubble role={role} content={content} />}
      {toolCalls && <ToolCallsView calls={toolCalls} />}
      {finishReason && (
        <div className="text-xs text-text-muted">
          finish: <code className="font-mono">{finishReason}</code>
        </div>
      )}
    </div>
  )
}

function StringView({ text }: { text: string }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border border-warm bg-cream px-4 py-3 font-mono text-xs text-text-dark">
      {text}
    </pre>
  )
}

function ToolCallsView({ calls }: { calls: ToolCall[] }) {
  return (
    <ul className="space-y-1.5">
      {calls.map((c, i) => (
        <li key={c.id ?? i} className="rounded-md border border-warm bg-white px-3 py-2 text-xs">
          <div className="font-mono text-text-dark">→ {c.name}</div>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-cream px-2 py-1 font-mono text-[11px] text-text-mid">
            {safeJson(c.args)}
          </pre>
        </li>
      ))}
    </ul>
  )
}

function Bubble({ role, content }: { role: string; content: string }) {
  const tone = roleTone(role)
  return (
    <div className={`rounded-xl border ${tone.border} ${tone.bg} p-3`}>
      <div className={`text-[10px] font-semibold uppercase tracking-wide ${tone.label}`}>
        {role}
      </div>
      <div className="mt-1 whitespace-pre-wrap font-mono text-xs leading-relaxed text-text-dark">
        {content}
      </div>
    </div>
  )
}

function roleTone(role: string): { border: string; bg: string; label: string } {
  switch (role) {
    case 'system':
      return { border: 'border-accent/40', bg: 'bg-accent/10', label: 'text-accent-dark' }
    case 'user':
      return { border: 'border-primary/30', bg: 'bg-primary/5', label: 'text-primary-dark' }
    case 'assistant':
      return { border: 'border-forest/30', bg: 'bg-forest/5', label: 'text-forest' }
    case 'tool':
      return { border: 'border-warm', bg: 'bg-warm/30', label: 'text-text-mid' }
    default:
      return { border: 'border-warm', bg: 'bg-cream', label: 'text-text-mid' }
  }
}

function RawJson({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-xl border border-warm bg-cream px-4 py-3 font-mono text-xs text-text-dark">
      {safeJson(value)}
    </pre>
  )
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
