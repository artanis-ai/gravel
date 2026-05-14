/**
 * VercelAIObject — renderer for `vercel-ai.generateObject` and
 * `vercel-ai.streamObject` (v4+).
 *
 * Input shape mirrors VercelAIText (`system`/`prompt`/`messages`)
 * plus a `schema` field carrying the JSON-schema view of the Zod
 * schema. We surface the schema as its own card alongside the
 * prompt so reviewers can see what the model was constrained to.
 *
 * Output shape: `object` (the structured value), `finishReason`,
 * `usage`. Some variants ship additional v4+ fields (`warnings`,
 * `reasoning`, etc.) — pass through to HumanValue.
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import { Message, type MessageRole } from '../Message'
import type { Renderer } from '../types'
import { summariseContent } from '../summarise'

export const VercelAIObjectRenderer: Renderer = ({ input, output }) => {
  const inputMessages = extractInputMessages(input)
  const schema = extractSchema(input)
  const mode = isPlainObject(input) && typeof input.output === 'string' ? input.output : null

  const inputPane = (
    <div className="space-y-2">
      {inputMessages.map((m, i) => (
        <ObjectMessageView
          key={`in-${i}`}
          msg={m}
          initiallyOpen={i === inputMessages.length - 1}
        />
      ))}
      {(schema !== null || mode) && (
        <div className="rounded border border-warm bg-warm/10 p-3 text-xs">
          <div className="mb-1 flex items-baseline gap-2 text-[11px] uppercase tracking-wide text-text-muted">
            <span>Schema</span>
            {mode && <span className="font-mono lowercase">mode: {mode}</span>}
          </div>
          {schema !== null ? <HumanValue value={schema} /> : <span>(none)</span>}
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

function extractSchema(input: unknown): unknown {
  if (!isPlainObject(input)) return null
  if ('schema' in input && input.schema !== undefined) return input.schema
  return null
}

// ---- views ----

function ObjectMessageView({
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
        <div className="space-y-2 text-sm">
          {typeof msg.content === 'string' ? (
            <p className="whitespace-pre-wrap break-words">{msg.content}</p>
          ) : (
            <HumanValue value={msg.content} />
          )}
        </div>
      }
    />
  )
}

function renderOutput(output: unknown): ReactNode {
  if (!isPlainObject(output)) {
    return output === null || output === undefined ? null : <HumanValue value={output} />
  }
  const obj = 'object' in output ? output.object : undefined
  const finishReason = typeof output.finishReason === 'string' ? output.finishReason : null
  const warnings = Array.isArray(output.warnings) ? output.warnings : null

  const captions: string[] = []
  if (finishReason && finishReason !== 'stop') captions.push(`finish: ${finishReason}`)

  return (
    <div className="space-y-2">
      <Message
        role="assistant"
        initiallyOpen
        summary={summariseContent(obj)}
        caption={captions.length > 0 ? captions.join(' · ') : undefined}
        content={
          <div className="space-y-2 text-sm">
            {obj !== undefined ? (
              <HumanValue value={obj} />
            ) : (
              <span className="text-text-muted italic">(no object)</span>
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
