/**
 * VercelAIText — renderer for `vercel-ai.generateText` and
 * `vercel-ai.streamText` (v4+ naming).
 *
 * Input shape:
 *   - `system?: string`, `prompt?: string` OR
 *   - `messages: [{role, content: string | ContentPart[]}]`
 *   - `tools?: { [name]: { description, inputSchema } }`
 *
 * Output shape (consolidated after stream finishes):
 *   - `text: string` (assembled assistant message)
 *   - `content: ContentPart[]` (text + tool-call + tool-result parts)
 *   - `finishReason: string`
 *   - `usage: {inputTokens, outputTokens, totalTokens}`
 *   - `toolCalls`, `toolResults`, `steps`, `reasoning`,
 *     `reasoningText`, `sources`, `files`, `warnings`,
 *     `providerMetadata` (each optional, pruned if undefined/empty)
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import { Message, type MessageRole } from '../Message'
import type { Renderer } from '../types'
import { summariseContent } from '../summarise'

export const VercelAITextRenderer: Renderer = ({ input, output }) => {
  const inputMessages = extractInputMessages(input)
  const tools = extractTools(input)

  const inputPane = (
    <div className="space-y-2">
      {inputMessages.map((m, i) => (
        <VercelMessageView
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

  const outputPane = renderOutput(output)
  return { input: inputPane, output: outputPane }
}

// ---- extraction ----

interface VercelMessage {
  role: MessageRole
  content: unknown
}

function extractInputMessages(input: unknown): VercelMessage[] {
  if (!isPlainObject(input)) return []
  // messages array takes precedence; otherwise reconstruct from
  // system + prompt.
  if (Array.isArray(input.messages)) {
    return input.messages.map((m) => normaliseMessage(m))
  }
  const synth: VercelMessage[] = []
  if (typeof input.system === 'string' && input.system.length > 0) {
    synth.push({ role: 'system', content: input.system })
  }
  if (typeof input.prompt === 'string') {
    synth.push({ role: 'user', content: input.prompt })
  } else if (Array.isArray(input.prompt)) {
    synth.push({ role: 'user', content: input.prompt })
  }
  return synth
}

function normaliseMessage(raw: unknown): VercelMessage {
  if (!isPlainObject(raw)) return { role: 'unknown', content: raw }
  const role = typeof raw.role === 'string' ? roleFromString(raw.role) : 'unknown'
  return { role, content: 'content' in raw ? raw.content : null }
}

function extractTools(input: unknown): Array<{ name: string; tool: unknown }> {
  if (!isPlainObject(input)) return []
  const tools = input.tools
  if (!isPlainObject(tools)) return []
  return Object.entries(tools).map(([name, tool]) => ({ name, tool }))
}

// ---- views ----

function VercelMessageView({
  msg,
  initiallyOpen,
}: {
  msg: VercelMessage
  initiallyOpen: boolean
}): ReactNode {
  return (
    <Message
      role={msg.role}
      initiallyOpen={initiallyOpen}
      summary={summariseContent(msg.content)}
      content={
        <div className="space-y-2 text-sm">{renderContent(msg.content)}</div>
      }
    />
  )
}

function renderOutput(output: unknown): ReactNode {
  if (!isPlainObject(output)) {
    return output === null || output === undefined ? null : <HumanValue value={output} />
  }
  const text = typeof output.text === 'string' ? output.text : null
  const finishReason = typeof output.finishReason === 'string' ? output.finishReason : null
  const reasoningText =
    typeof output.reasoningText === 'string' ? output.reasoningText : null
  const reasoning = Array.isArray(output.reasoning) ? output.reasoning : null
  const toolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : null
  const toolResults = Array.isArray(output.toolResults) ? output.toolResults : null
  const sources = Array.isArray(output.sources) ? output.sources : null
  const warnings = Array.isArray(output.warnings) ? output.warnings : null
  const files = Array.isArray(output.files) ? output.files : null

  const captions: string[] = []
  if (finishReason && finishReason !== 'stop') captions.push(`finish: ${finishReason}`)

  return (
    <div className="space-y-2">
      <Message
        role="assistant"
        initiallyOpen
        summary={summariseContent(text ?? output.content)}
        caption={captions.length > 0 ? captions.join(' · ') : undefined}
        content={
          <div className="space-y-2 text-sm">
            {text !== null && text.length > 0 && (
              <p className="whitespace-pre-wrap break-words">{text}</p>
            )}
            {text === null && renderContent(output.content)}
            {reasoningText && (
              <div className="rounded border border-warm bg-warm/10 p-2 text-xs italic">
                <span className="mr-2 font-medium uppercase tracking-wide text-text-muted">
                  Reasoning
                </span>
                <span className="whitespace-pre-wrap">{reasoningText}</span>
              </div>
            )}
            {!reasoningText && reasoning && (
              <div className="rounded border border-warm bg-warm/10 p-2 text-xs italic">
                <span className="mr-2 font-medium uppercase tracking-wide text-text-muted">
                  Reasoning
                </span>
                <HumanValue value={reasoning} />
              </div>
            )}
            {toolCalls && toolCalls.length > 0 && (
              <div className="space-y-1">
                {toolCalls.map((tc, i) => (
                  <ToolCallBlock key={i} call={tc} />
                ))}
              </div>
            )}
            {toolResults && toolResults.length > 0 && (
              <div className="space-y-1">
                {toolResults.map((tr, i) => (
                  <ToolResultBlock key={i} result={tr} />
                ))}
              </div>
            )}
            {sources && sources.length > 0 && <SourcesBlock sources={sources} />}
            {files && files.length > 0 && (
              <div className="rounded border border-warm bg-white p-2 text-xs">
                <h5 className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
                  Files ({files.length})
                </h5>
                <HumanValue value={files} />
              </div>
            )}
            {warnings && warnings.length > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs">
                <h5 className="mb-1 text-[10px] uppercase tracking-wide text-amber-700">
                  Warnings ({warnings.length})
                </h5>
                <HumanValue value={warnings} />
              </div>
            )}
          </div>
        }
      />
    </div>
  )
}

function renderContent(content: unknown): ReactNode {
  if (content === null || content === undefined) return null
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap break-words">{content}</p>
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2">
        {content.map((part, i) => (
          <VercelContentPart key={i} part={part} />
        ))}
      </div>
    )
  }
  return <HumanValue value={content} />
}

function VercelContentPart({ part }: { part: unknown }): ReactNode {
  if (!isPlainObject(part)) return <HumanValue value={part} />
  const type = typeof part.type === 'string' ? part.type : null
  switch (type) {
    case 'text':
      return (
        <p className="whitespace-pre-wrap break-words">
          {typeof part.text === 'string' ? part.text : <HumanValue value={part} />}
        </p>
      )
    case 'tool-call':
      return (
        <ToolCallBlock
          call={{
            toolCallId: typeof part.toolCallId === 'string' ? part.toolCallId : undefined,
            toolName: typeof part.toolName === 'string' ? part.toolName : undefined,
            input: 'input' in part ? part.input : 'args' in part ? part.args : undefined,
          }}
        />
      )
    case 'tool-result':
      return (
        <ToolResultBlock
          result={{
            toolCallId: typeof part.toolCallId === 'string' ? part.toolCallId : undefined,
            toolName: typeof part.toolName === 'string' ? part.toolName : undefined,
            output: 'output' in part ? part.output : 'result' in part ? part.result : undefined,
          }}
        />
      )
    case 'reasoning':
      return (
        <div className="rounded border border-warm bg-warm/10 p-2 text-xs italic">
          <span className="mr-2 font-medium uppercase tracking-wide text-text-muted">
            Reasoning
          </span>
          {typeof part.text === 'string' ? (
            <span className="whitespace-pre-wrap">{part.text}</span>
          ) : (
            <HumanValue value={part} />
          )}
        </div>
      )
    default:
      return <HumanValue value={part} />
  }
}

function ToolCallBlock({ call }: { call: unknown }): ReactNode {
  if (!isPlainObject(call)) return <HumanValue value={call} />
  const name = typeof call.toolName === 'string' ? call.toolName : null
  const id = typeof call.toolCallId === 'string' ? call.toolCallId : null
  const args = 'input' in call ? call.input : 'args' in call ? call.args : null
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

function ToolResultBlock({ result }: { result: unknown }): ReactNode {
  if (!isPlainObject(result)) return <HumanValue value={result} />
  const name = typeof result.toolName === 'string' ? result.toolName : null
  const id = typeof result.toolCallId === 'string' ? result.toolCallId : null
  const out = 'output' in result ? result.output : 'result' in result ? result.result : null
  return (
    <div className="rounded border border-warm bg-warm/30 p-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-warm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-dark">
          Tool result
        </span>
        {name && <span className="font-mono text-[11px] font-medium">{name}</span>}
        {id && <span className="font-mono text-[10px] text-text-muted">{id}</span>}
      </div>
      {out !== null && out !== undefined && (
        <div className="mt-1.5">
          <HumanValue value={out} />
        </div>
      )}
    </div>
  )
}

function SourcesBlock({ sources }: { sources: unknown[] }): ReactNode {
  return (
    <div className="rounded border border-warm bg-white p-2 text-xs">
      <h5 className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
        Sources ({sources.length})
      </h5>
      <ul className="ml-3 list-disc space-y-1">
        {sources.map((s, i) => (
          <li key={i}>
            <HumanValue value={s} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function ToolsSection({ tools }: { tools: Array<{ name: string; tool: unknown }> }): ReactNode {
  return (
    <div>
      <h5 className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">
        Tools ({tools.length})
      </h5>
      <div className="space-y-1.5">
        {tools.map(({ name, tool }) => (
          <ToolDef key={name} name={name} tool={tool} />
        ))}
      </div>
    </div>
  )
}

function ToolDef({ name, tool }: { name: string; tool: unknown }): ReactNode {
  if (!isPlainObject(tool)) {
    return (
      <div className="rounded border border-warm bg-white px-2 py-1.5">
        <span className="font-mono text-[11px] font-medium text-forest">{name}</span>
      </div>
    )
  }
  const description = typeof tool.description === 'string' ? tool.description : null
  // v4+ uses `inputSchema`; older v3 used `parameters`.
  const schema = 'inputSchema' in tool ? tool.inputSchema : tool.parameters
  return (
    <div className="rounded border border-warm bg-white px-2 py-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[11px] font-medium text-forest">{name}</span>
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
