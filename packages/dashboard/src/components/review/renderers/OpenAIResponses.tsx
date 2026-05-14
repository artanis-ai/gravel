/**
 * OpenAIResponses — renderer for `openai.responses.create`.
 *
 * The Responses API is item-based: `input` is a list of items, each
 * with a `type` discriminator (`message`, `function_call`,
 * `function_call_output`, and a long tail of provider-specific
 * items the Phase-1 audit catalogued). `output.output` is the
 * same item taxonomy.
 *
 * Phase-4 dedicated paths:
 *   - `message` items (system / user / assistant with content parts
 *     `input_text`, `output_text`, `input_image`, `input_file`)
 *   - `function_call` items (assistant-side tool call)
 *   - `function_call_output` items (matched back to the call via
 *     `call_id`)
 *
 * Everything else (reasoning, web_search_call, file_search_call,
 * computer_call, code_interpreter_call, image_generation_call,
 * mcp_*, refusal item, etc.) falls through to `HumanValue` so
 * reviewers still see the structure, no JSON dump.
 *
 * Collapse defaults follow the dashboard convention:
 *   - `system` / `developer` → collapsed.
 *   - `user` → collapsed except the LAST user message.
 *   - `function_call` / `function_call_output` → open.
 *   - Output items → open.
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import { Message, type MessageRole } from '../Message'
import type { Renderer } from '../types'
import { summariseContent } from '../summarise'
import { ClickableImage } from '../ClickableMedia'

export const OpenAIResponsesRenderer: Renderer = ({ input, output }) => {
  const inputItems = extractItems(input, 'input')
  const outputItems = extractItems(output, 'output')
  const tools = extractTools(input)
  const instructions = extractInstructions(input)

  const lastUserIdx = lastIndexOf(inputItems, (it) => it.kind === 'message' && it.role === 'user')

  const inputPane = (
    <div className="space-y-2">
      {instructions && (
        <Message
          role="system"
          initiallyOpen={false}
          summary={summariseContent(instructions)}
          caption="instructions"
          content={<p className="whitespace-pre-wrap break-words">{instructions}</p>}
        />
      )}
      {inputItems.map((item, i) => (
        <ResponseItemView
          key={`in-${i}`}
          item={item}
          initiallyOpen={item.kind === 'message' ? i === lastUserIdx : true}
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
    outputItems.length === 0 ? null : (
      <div className="space-y-2">
        {outputItems.map((item, i) => (
          <ResponseItemView key={`out-${i}`} item={item} initiallyOpen />
        ))}
      </div>
    )

  return { input: inputPane, output: outputPane }
}

// ---- extraction ----

type ResponseItem =
  | { kind: 'message'; role: string; content: unknown; raw: Record<string, unknown> }
  | { kind: 'function_call'; call_id?: string; name?: string; args: unknown; raw: Record<string, unknown> }
  | { kind: 'function_call_output'; call_id?: string; output: unknown; raw: Record<string, unknown> }
  | { kind: 'reasoning'; raw: Record<string, unknown> }
  | { kind: 'other'; type: string | null; raw: unknown }

function extractItems(value: unknown, side: 'input' | 'output'): ResponseItem[] {
  if (!isPlainObject(value)) return []
  // Input side: items live under `input` (string or array). Output
  // side: items live under `output` (array). Both can be missing
  // when the call errored before any output was generated.
  const raw = side === 'input' ? value.input : value.output
  if (typeof raw === 'string') {
    // Shorthand where `input` is just a prompt string — wrap it as
    // a user message item.
    return [{ kind: 'message', role: 'user', content: raw, raw: { type: 'message', role: 'user', content: raw } }]
  }
  if (!Array.isArray(raw)) return []
  return raw.map((item) => normaliseItem(item))
}

function normaliseItem(raw: unknown): ResponseItem {
  if (!isPlainObject(raw)) return { kind: 'other', type: null, raw }
  const type = typeof raw.type === 'string' ? raw.type : null
  switch (type) {
    case 'message':
      return {
        kind: 'message',
        role: typeof raw.role === 'string' ? raw.role : 'unknown',
        content: 'content' in raw ? raw.content : null,
        raw,
      }
    case 'function_call':
      return {
        kind: 'function_call',
        call_id: typeof raw.call_id === 'string' ? raw.call_id : undefined,
        name: typeof raw.name === 'string' ? raw.name : undefined,
        args: parseJsonString(raw.arguments),
        raw,
      }
    case 'function_call_output':
      return {
        kind: 'function_call_output',
        call_id: typeof raw.call_id === 'string' ? raw.call_id : undefined,
        output: parseJsonString(raw.output),
        raw,
      }
    case 'reasoning':
      return { kind: 'reasoning', raw }
    default:
      return { kind: 'other', type, raw }
  }
}

function extractTools(input: unknown): unknown[] {
  if (!isPlainObject(input)) return []
  return Array.isArray(input.tools) ? input.tools : []
}

function extractInstructions(input: unknown): string | null {
  if (!isPlainObject(input)) return null
  return typeof input.instructions === 'string' && input.instructions.length > 0
    ? input.instructions
    : null
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

function lastIndexOf<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i
  }
  return -1
}

// ---- views ----

function ResponseItemView({
  item,
  initiallyOpen,
}: {
  item: ResponseItem
  initiallyOpen: boolean
}): ReactNode {
  switch (item.kind) {
    case 'message':
      return (
        <Message
          role={roleFromString(item.role)}
          initiallyOpen={initiallyOpen}
          summary={summariseContent(item.content)}
          content={
            <div className="space-y-2 text-sm">{renderContent(item.content)}</div>
          }
        />
      )
    case 'function_call':
      return (
        <Message
          role="assistant"
          initiallyOpen={initiallyOpen}
          summary={item.name ? `tool call: ${item.name}` : 'tool call'}
          caption={item.call_id ? `call_id: ${item.call_id}` : undefined}
          variant="tool"
          content={<FunctionCallBlock name={item.name} args={item.args} />}
        />
      )
    case 'function_call_output':
      return (
        <Message
          role="tool"
          initiallyOpen={initiallyOpen}
          summary={summariseContent(item.output)}
          caption={item.call_id ? `for: ${item.call_id}` : undefined}
          content={<HumanValue value={item.output} />}
        />
      )
    case 'reasoning':
      return (
        <Message
          role="assistant"
          initiallyOpen={initiallyOpen}
          summary={summariseReasoning(item.raw)}
          variant="reasoning"
          caption="reasoning"
          content={<HumanValue value={item.raw} />}
        />
      )
    default:
      return (
        <div className="rounded border border-warm bg-warm/10 p-2 text-xs">
          <div className="mb-1 font-medium uppercase tracking-wide text-text-muted">
            {item.type ?? 'item'}
          </div>
          <HumanValue value={item.raw} />
        </div>
      )
  }
}

function summariseReasoning(raw: Record<string, unknown>): string {
  const summary = Array.isArray(raw.summary) ? raw.summary : null
  if (summary) {
    for (const s of summary) {
      if (isPlainObject(s) && typeof s.summary_text === 'string') return summariseContent(s.summary_text)
    }
  }
  return 'reasoning'
}

function FunctionCallBlock({
  name,
  args,
}: {
  name?: string
  args: unknown
}): ReactNode {
  return (
    <div className="rounded border border-forest/30 bg-forest/5 p-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-forest/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-forest">
          Tool call
        </span>
        {name && <span className="font-mono text-[11px] font-medium">{name}</span>}
      </div>
      {args !== undefined && args !== null && (
        <div className="mt-1.5">
          <HumanValue value={args} />
        </div>
      )}
    </div>
  )
}

function renderContent(content: unknown): ReactNode {
  if (content === null || content === undefined) return null
  if (typeof content === 'string') {
    if (content.length === 0) return null
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
          <ResponsesContentPart key={i} part={part} />
        ))}
      </div>
    )
  }
  return <HumanValue value={content} />
}

function ResponsesContentPart({ part }: { part: unknown }): ReactNode {
  if (!isPlainObject(part)) return <HumanValue value={part} />
  const type = typeof part.type === 'string' ? part.type : null
  switch (type) {
    case 'input_text':
    case 'output_text':
    case 'text':
      return (
        <p className="whitespace-pre-wrap break-words">
          {typeof part.text === 'string' ? part.text : <HumanValue value={part} />}
        </p>
      )
    case 'input_image': {
      const url = typeof part.image_url === 'string' ? part.image_url : null
      const detail = typeof part.detail === 'string' ? part.detail : null
      if (!url) return <HumanValue value={part} />
      return (
        <span className="inline-flex items-start gap-2">
          <ClickableImage src={url} alt="image attachment" className="max-h-32 max-w-xs" />
          {detail && <span className="text-[10px] text-text-muted">detail: {detail}</span>}
        </span>
      )
    }
    case 'input_file': {
      const file =
        typeof part.file_id === 'string'
          ? { file_id: part.file_id }
          : typeof part.filename === 'string'
            ? { filename: part.filename }
            : part
      return (
        <span className="inline-flex items-baseline gap-2 rounded bg-warm/40 px-2 py-1 text-xs">
          <span className="font-medium uppercase tracking-wide text-text-muted">File</span>
          <HumanValue value={file} />
        </span>
      )
    }
    case 'refusal':
      return (
        <span className="block rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900">
          <span className="mr-2 font-medium uppercase tracking-wide text-red-700">Refusal</span>
          {typeof part.refusal === 'string' ? part.refusal : <HumanValue value={part} />}
        </span>
      )
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
  // Responses-API tools are flatter than Chat tools: name + description
  // + parameters live at the top level (not nested under `function`).
  const name = typeof tool.name === 'string' ? tool.name : null
  const description = typeof tool.description === 'string' ? tool.description : null
  const parameters = 'parameters' in tool ? tool.parameters : null
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

function roleFromString(role: string): MessageRole {
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
