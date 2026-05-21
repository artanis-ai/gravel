/**
 * AnthropicMessages — renderer for `anthropic.messages.create`
 * and `.stream`. Returns `{input, output}` for side-by-side
 * layout.
 *
 * Covered shapes (each pinned by a fixture):
 *   - Plain user / assistant text turns
 *   - Top-level `system` field (string OR array of typed blocks)
 *     surfaced as a System message at the top of the input pane
 *   - Content blocks: `text` (with optional `citations[]`),
 *     `image` (base64 source; url + file sources fall through to
 *     HumanValue per ROADMAP), `tool_use`, `tool_result`,
 *     `document` (base64 PDF)
 *   - Streaming: assembled message shows in the output pane;
 *     chunk-list lives under metadata.states (handled by chrome)
 *   - Erroring: output is null, error banner is painted by the
 *     ReviewSurface
 *   - Stop reasons other than `end_turn` get a small caption
 *
 * Collapse defaults follow the dashboard convention:
 *   - System → collapsed.
 *   - User turn → collapsed except the LAST.
 *   - Assistant turns in input (multi-turn history) → open.
 *   - Output → open.
 *
 * Unhandled-but-deferred (per ROADMAP): server tools, bash /
 * text_editor / computer-use built-in tool types, `thinking` /
 * `redacted_thinking` blocks, `search_result` / `container_upload`,
 * Messages Batches API. All fall through to HumanValue rather than
 * silently dropping.
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import { Message } from '../Message'
import type { Renderer } from '../types'
import { summariseContent } from '../summarise'
import { ClickableImage, ClickablePdf } from '../ClickableMedia'
import { tryParseStructuredString } from '../../../lib/parseStructured'

export const AnthropicMessagesRenderer: Renderer = ({ input, output }) => {
  const systemMessages = extractSystem(input)
  const turns = extractTurns(input)
  const assistant = extractAssistantOutput(output)
  const tools = extractTools(input)

  const inputPane = (
    <div className="space-y-2">
      {systemMessages.map((s, i) => (
        <Message
          key={`sys-${i}`}
          role="system"
          initiallyOpen={false}
          summary={summariseContent(s.content)}
          caption={s.cacheControl ? 'cache_control set' : undefined}
          content={renderBlocks(s.content)}
        />
      ))}
      {turns.map((t, i) => (
        <Message
          key={`turn-${i}`}
          role={t.role === 'user' ? 'user' : 'assistant'}
          initiallyOpen={i === turns.length - 1}
          summary={summariseContent(t.content)}
          content={renderBlocks(t.content)}
        />
      ))}
      {tools.length > 0 && <ToolsSection tools={tools} />}
    </div>
  )

  const outputPane = assistant ? (
    <Message
      role="assistant"
      initiallyOpen
      summary={summariseContent(assistant.content)}
      caption={
        assistant.stop_reason && assistant.stop_reason !== 'end_turn'
          ? `stop: ${assistant.stop_reason}`
          : undefined
      }
      content={renderBlocks(assistant.content)}
    />
  ) : null

  return { input: inputPane, output: outputPane }
}

// ---- extraction ----

interface SystemMessage {
  content: unknown
  cacheControl: boolean
}

interface Turn {
  role: 'user' | 'assistant'
  content: unknown
}

interface AssistantOutput {
  content: unknown
  stop_reason: string | null
}

function extractSystem(input: unknown): SystemMessage[] {
  if (!isPlainObject(input)) return []
  const sys = input.system
  if (sys === null || sys === undefined) return []
  if (typeof sys === 'string') {
    return sys.length === 0 ? [] : [{ content: sys, cacheControl: false }]
  }
  if (Array.isArray(sys)) {
    return sys.map((block) => ({
      content: block,
      cacheControl: isPlainObject(block) && 'cache_control' in block,
    }))
  }
  return [{ content: sys, cacheControl: false }]
}

function extractTurns(input: unknown): Turn[] {
  if (!isPlainObject(input)) return []
  const messages = input.messages
  if (!Array.isArray(messages)) return []
  return messages.map((m) => {
    if (!isPlainObject(m)) return { role: 'user', content: m }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    return { role, content: m.content }
  })
}

function extractAssistantOutput(output: unknown): AssistantOutput | null {
  if (!isPlainObject(output)) return null
  if (output.type !== 'message' && !('content' in output)) return null
  return {
    content: 'content' in output ? output.content : null,
    stop_reason: typeof output.stop_reason === 'string' ? output.stop_reason : null,
  }
}

function extractTools(input: unknown): unknown[] {
  if (!isPlainObject(input)) return []
  return Array.isArray(input.tools) ? input.tools : []
}

// ---- block rendering ----

function renderBlocks(content: unknown): ReactNode {
  if (content === null || content === undefined) return null
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap break-words">{content}</p>
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2">
        {content.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </div>
    )
  }
  return <HumanValue value={content} />
}

function BlockView({ block }: { block: unknown }): ReactNode {
  if (!isPlainObject(block)) return <HumanValue value={block} />
  const type = typeof block.type === 'string' ? block.type : null
  switch (type) {
    case 'text':
      return <TextBlock block={block} />
    case 'image':
      return <ImageBlock block={block} />
    case 'tool_use':
      return <ToolUseBlock block={block} />
    case 'tool_result':
      return <ToolResultBlock block={block} />
    case 'document':
      return <DocumentBlock block={block} />
    case 'thinking':
    case 'redacted_thinking':
      return <ThinkingBlock block={block} kind={type} />
    default:
      return (
        <div className="rounded border border-warm bg-warm/20 p-2 text-xs">
          <span className="mr-2 font-mono text-[10px] uppercase tracking-wide text-text-muted">
            {type ?? 'block'}
          </span>
          <HumanValue value={block} />
        </div>
      )
  }
}

function TextBlock({ block }: { block: Record<string, unknown> }): ReactNode {
  const text = typeof block.text === 'string' ? block.text : ''
  const citations =
    Array.isArray(block.citations) && block.citations.length > 0
      ? (block.citations as unknown[])
      : null
  // Auto-format JSON-shaped text blocks. When a customer uses Anthropic
  // with response_format-style structured output, the assistant returns
  // one text block whose entire body is JSON; rendering it raw makes
  // the trace UI ugly (Olly's 2026-05-21 dogfooding). Try-parse and
  // pretty-print when the result is an object / array.
  const parsed = tryParseStructuredString(text)
  if (parsed !== undefined && (Array.isArray(parsed) || isPlainObject(parsed))) {
    return (
      <span className="block">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-warm bg-warm/10 p-2 font-mono text-[11px]">
          {JSON.stringify(parsed, null, 2)}
        </pre>
        {citations && (
          <span className="mt-1 flex flex-wrap gap-1">
            {citations.map((c, i) => (
              <CitationChip key={i} citation={c} />
            ))}
          </span>
        )}
      </span>
    )
  }
  return (
    <span className="block">
      <span className="whitespace-pre-wrap break-words">{text}</span>
      {citations && (
        <span className="mt-1 flex flex-wrap gap-1">
          {citations.map((c, i) => (
            <CitationChip key={i} citation={c} />
          ))}
        </span>
      )}
    </span>
  )
}

/**
 * ThinkingBlock — Anthropic's extended-thinking output. The API returns
 * a `thinking` block per assistant turn that contains the model's
 * scratchpad (`thinking` string) plus an opaque `signature` (700+
 * char base64 cryptographic blob the API needs back if you replay the
 * turn). Pre-v0.10.0 the renderer dumped both inline; Olly's
 * 2026-05-21 trace had a 712-char signature taking up the entire
 * Review pane above the actual JSON output. Hide behind a disclosure.
 *
 * `redacted_thinking` is the same shape with `data` instead of
 * `thinking` (server returns this when the thinking content itself
 * was redacted for policy reasons). Always collapsed — there's no
 * useful content to read inline.
 */
function ThinkingBlock({
  block,
  kind,
}: {
  block: Record<string, unknown>
  kind: 'thinking' | 'redacted_thinking'
}): ReactNode {
  const thought =
    typeof block.thinking === 'string'
      ? block.thinking
      : typeof block.data === 'string'
        ? block.data
        : ''
  const signature = typeof block.signature === 'string' ? block.signature : ''
  // Empty thinking block (signature only, no thought): show as a tiny
  // pill instead of an empty disclosure. Common for short turns.
  if (!thought.trim()) {
    return (
      <div className="text-[10px] text-text-muted">
        <span className="inline-flex items-center rounded bg-warm/20 px-1.5 py-0.5 font-mono uppercase tracking-wide">
          {kind === 'redacted_thinking' ? 'thinking (redacted)' : 'thinking (empty)'}
        </span>
      </div>
    )
  }
  return (
    <details className="rounded border border-warm bg-warm/10 text-xs">
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[11px] text-text-muted">
        <span className="inline-flex items-center rounded bg-warm/40 px-1.5 py-0.5 font-mono uppercase tracking-wide">
          {kind === 'redacted_thinking' ? 'redacted_thinking' : 'thinking'}
        </span>
        <span className="truncate">{thought.slice(0, 80)}{thought.length > 80 ? '…' : ''}</span>
      </summary>
      <div className="space-y-2 border-t border-warm px-2 py-2">
        <span className="block whitespace-pre-wrap break-words text-text-dark">{thought}</span>
        {signature && (
          <details className="text-[10px] text-text-muted">
            <summary className="cursor-pointer">signature ({signature.length} chars)</summary>
            <span className="mt-1 block break-all font-mono text-[10px]">{signature}</span>
          </details>
        )}
      </div>
    </details>
  )
}

function CitationChip({ citation }: { citation: unknown }): ReactNode {
  if (!isPlainObject(citation)) return <HumanValue value={citation} />
  const title =
    typeof citation.document_title === 'string'
      ? citation.document_title
      : typeof citation.url === 'string'
        ? citation.url
        : null
  const cited = typeof citation.cited_text === 'string' ? citation.cited_text : null
  return (
    <span
      className="inline-flex max-w-md items-center gap-1 rounded border border-warm bg-warm/30 px-1.5 py-0.5 text-[10px]"
      title={cited ?? undefined}
    >
      <span className="font-medium text-text-dark">cite</span>
      {title && <span className="break-all text-text-muted">{title}</span>}
    </span>
  )
}

function ImageBlock({ block }: { block: Record<string, unknown> }): ReactNode {
  const source = isPlainObject(block.source) ? block.source : null
  const srcType = source && typeof source.type === 'string' ? source.type : null
  if (srcType === 'base64') {
    const mediaType =
      typeof source?.media_type === 'string' ? source.media_type : 'image/png'
    const data = typeof source?.data === 'string' ? source.data : ''
    if (data.length === 0) return <HumanValue value={block} />
    return (
      <ClickableImage
        src={`data:${mediaType};base64,${data}`}
        alt="image attachment"
        className="max-h-48 max-w-xs"
      />
    )
  }
  if (srcType === 'url' && typeof source?.url === 'string') {
    return (
      <ClickableImage
        src={source.url}
        alt="image attachment"
        className="max-h-48 max-w-xs"
      />
    )
  }
  return <HumanValue value={block} />
}

function ToolUseBlock({ block }: { block: Record<string, unknown> }): ReactNode {
  const name = typeof block.name === 'string' ? block.name : null
  const id = typeof block.id === 'string' ? block.id : null
  return (
    <div className="rounded border border-forest/30 bg-forest/5 p-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-forest/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-forest">
          Tool use
        </span>
        {name && <span className="font-mono text-[11px] font-medium">{name}</span>}
        {id && <span className="font-mono text-[10px] text-text-muted">{id}</span>}
      </div>
      {'input' in block && (
        <div className="mt-1.5">
          <HumanValue value={block.input} />
        </div>
      )}
    </div>
  )
}

function ToolResultBlock({ block }: { block: Record<string, unknown> }): ReactNode {
  const tuid = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
  const isError = block.is_error === true
  const content = 'content' in block ? block.content : null
  const parsed = typeof content === 'string' ? tryParseJson(content) : content
  return (
    <div
      className={
        isError
          ? 'rounded border border-red-200 bg-red-50 p-2 text-xs'
          : 'rounded border border-warm bg-warm/30 p-2 text-xs'
      }
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={
            isError
              ? 'inline-flex items-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-700'
              : 'inline-flex items-center rounded bg-warm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-dark'
          }
        >
          Tool result
        </span>
        {tuid && <span className="font-mono text-[10px] text-text-muted">for: {tuid}</span>}
      </div>
      <div className="mt-1.5">
        <HumanValue value={parsed} />
      </div>
    </div>
  )
}

function DocumentBlock({ block }: { block: Record<string, unknown> }): ReactNode {
  const title = typeof block.title === 'string' ? block.title : 'document'
  const source = isPlainObject(block.source) ? block.source : null
  const srcType = source && typeof source.type === 'string' ? source.type : null
  const mediaType =
    source && typeof source.media_type === 'string' ? source.media_type : null

  // Build a `src` we can hand to ClickablePdf when possible.
  let src: string | null = null
  if (srcType === 'base64') {
    const data = source && typeof source.data === 'string' ? source.data : null
    if (data && mediaType) src = `data:${mediaType};base64,${data}`
  } else if (srcType === 'url' && source && typeof source.url === 'string') {
    src = source.url
  }

  if (src) {
    // Embedded inline preview by default (no `thumbnail` prop) — see
    // ClickablePdf for the rationale: the previous button-only shape
    // hid PDFs from domain experts who never thought to click into
    // them. Enlarge button still pops the full-screen dialog.
    return <ClickablePdf src={src} title={title} />
  }

  return (
    <div className="rounded border border-warm bg-warm/30 p-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-warm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-dark">
          Document
        </span>
        <span className="font-medium">{title}</span>
        {mediaType && (
          <span className="font-mono text-[10px] text-text-muted">{mediaType}</span>
        )}
      </div>
    </div>
  )
}

function ToolsSection({ tools }: { tools: unknown[] }): ReactNode {
  return (
    <div className="rounded border border-warm bg-warm/10 p-3 text-xs">
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
  const name = typeof tool.name === 'string' ? tool.name : null
  const description = typeof tool.description === 'string' ? tool.description : null
  const schema = 'input_schema' in tool ? tool.input_schema : null
  const type =
    typeof tool.type === 'string' && tool.type !== tool.name ? tool.type : null
  if (!name) return <HumanValue value={tool} />
  return (
    <div className="rounded border border-warm bg-white px-2 py-1.5">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="font-mono text-[11px] font-medium text-forest">{name}</span>
        {type && <span className="font-mono text-[10px] text-text-muted">{type}</span>}
        {description && <span className="text-[11px] text-text-muted">{description}</span>}
      </div>
      {schema !== null && schema !== undefined && (
        <div className="mt-1 text-[11px]">
          <HumanValue value={schema} />
        </div>
      )}
    </div>
  )
}

function tryParseJson(v: string): unknown {
  const trimmed = v.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
