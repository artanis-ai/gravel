/**
 * GeminiChat — renderer for `gemini.models.generate_content` and
 * `gemini.models.generate_content_stream` (Google `google-genai` /
 * `@google/genai`). Returns `{input, output}` for side-by-side
 * layout.
 *
 * The Gemini API is content-blocks-shaped (closer to Anthropic
 * than OpenAI Chat): `contents[]` is an array of Content objects,
 * each with `role` ("user" | "model") and a list of `parts[]`. The
 * system instruction lives separately at `config.system_instruction`,
 * NOT inside the conversation. Output candidates use the same
 * Content/Part taxonomy.
 *
 * Covered shapes (each pinned by a fixture):
 *   - Plain user → model turn.
 *   - `config.system_instruction` surfaced as a System message
 *     above the conversation.
 *   - Tool calling: `function_declarations[]` in `config.tools[]`,
 *     `function_call` Part on the model side, `function_response`
 *     Part on the user side (multi-turn).
 *   - Multimodal `inline_data` (image / audio / PDF base64) and
 *     `file_data` (URI-referenced file).
 *   - Streaming: the SDK patch assembles candidates; chunk list
 *     lives in `metadata.states` (handled by the StreamObservations
 *     chrome).
 *   - Erroring: `output: null` + `metadata.error` painted by the
 *     ReviewSurface above.
 *   - Safety: `finish_reason: 'SAFETY'` shown as a caption pill;
 *     `safety_ratings[]` rendered as a small disclosure when any
 *     rating is non-`NEGLIGIBLE`.
 *
 * Naming: Python SDK uses snake_case attributes (`finish_reason`,
 * `usage_metadata`, `inline_data`); JS SDK uses camelCase
 * (`finishReason`, `usageMetadata`, `inlineData`). The renderer
 * accepts both forms via `pickField` and stays agnostic.
 *
 * Collapse defaults follow the dashboard convention:
 *   - System instruction → collapsed.
 *   - User turn → collapsed except the LAST.
 *   - Assistant ("model") turns in input (multi-turn history) → open.
 *   - Output → open.
 */
import type { ReactNode } from 'react'

import { HumanValue } from '../HumanValue'
import { Message, type MessageRole } from '../Message'
import type { Renderer } from '../types'
import { summariseContent } from '../summarise'
import { ClickableImage } from '../ClickableMedia'
import { tryParseStructuredString } from '../../../lib/parseStructured'

export const GeminiChatRenderer: Renderer = ({ input, output }) => {
  const systemText = extractSystemInstruction(input)
  const turns = extractContents(input)
  const tools = extractFunctionDeclarations(input)
  const candidates = extractCandidates(output)

  const inputPane = (
    <div className="space-y-2">
      {systemText !== null && (
        <Message
          role="system"
          initiallyOpen={false}
          summary={summariseContent(systemText)}
          caption="system_instruction"
          content={<p className="whitespace-pre-wrap break-words text-sm">{systemText}</p>}
        />
      )}
      {turns.map((t, i) => (
        <Message
          key={`turn-${i}`}
          role={roleFromGemini(t.role)}
          initiallyOpen={t.role === 'user' ? i === lastUserIdx(turns) : true}
          summary={summarisePartList(t.parts)}
          content={renderParts(t.parts)}
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
    candidates.length === 0 ? null : (
      <div className="space-y-2">
        {candidates.map((c, i) => (
          <CandidateView key={`cand-${i}`} candidate={c} total={candidates.length} index={i} />
        ))}
      </div>
    )

  return { input: inputPane, output: outputPane }
}

// ---- extraction ----

interface GeminiTurn {
  role: string
  parts: unknown[]
  raw: Record<string, unknown>
}

interface GeminiCandidate {
  content: { role: string; parts: unknown[] } | null
  finish_reason: string | null
  safety_ratings: unknown[] | null
  citation_metadata: unknown | null
  index: number
  raw: Record<string, unknown>
}

interface FunctionDeclaration {
  name: string | null
  description: string | null
  parameters: unknown
  raw: unknown
}

function extractSystemInstruction(input: unknown): string | null {
  if (!isPlainObject(input)) return null
  // Top-level or under `config`. Top-level shape is rare but possible
  // in some SDK versions; check both.
  const direct =
    typeof input.system_instruction === 'string'
      ? input.system_instruction
      : typeof input.systemInstruction === 'string'
        ? input.systemInstruction
        : null
  if (direct !== null) return direct
  const config = isPlainObject(input.config) ? input.config : null
  if (!config) return null
  if (typeof config.system_instruction === 'string') return config.system_instruction
  if (typeof config.systemInstruction === 'string') return config.systemInstruction
  // Sometimes system_instruction is a Content object with a `parts: [{text}]`
  // shape. Surface the flattened text.
  const candidate = config.system_instruction ?? config.systemInstruction
  if (isPlainObject(candidate)) {
    const parts = Array.isArray(candidate.parts) ? candidate.parts : null
    if (parts) {
      const text = parts
        .map((p) => (isPlainObject(p) && typeof p.text === 'string' ? p.text : ''))
        .filter((s) => s.length > 0)
        .join('\n')
      return text.length > 0 ? text : null
    }
  }
  return null
}

function extractContents(input: unknown): GeminiTurn[] {
  if (!isPlainObject(input)) return []
  const raw = input.contents
  if (typeof raw === 'string') {
    // SDK lets you pass `contents="..."` as a shorthand. Wrap it as
    // a user turn.
    return [{ role: 'user', parts: [{ text: raw }], raw: { role: 'user', parts: [{ text: raw }] } }]
  }
  if (!Array.isArray(raw)) return []
  return raw.map((c) => {
    if (!isPlainObject(c)) return { role: 'user', parts: [], raw: { role: 'user', parts: [] } }
    const role = typeof c.role === 'string' ? c.role : 'user'
    const parts = Array.isArray(c.parts) ? c.parts : []
    return { role, parts, raw: c }
  })
}

function extractFunctionDeclarations(input: unknown): FunctionDeclaration[] {
  if (!isPlainObject(input)) return []
  const config = isPlainObject(input.config) ? input.config : input
  const tools = Array.isArray(config.tools) ? config.tools : null
  if (!tools) return []
  const out: FunctionDeclaration[] = []
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue
    const decls = Array.isArray(tool.function_declarations)
      ? tool.function_declarations
      : Array.isArray(tool.functionDeclarations)
        ? tool.functionDeclarations
        : null
    if (!decls) continue
    for (const d of decls) {
      if (!isPlainObject(d)) continue
      out.push({
        name: typeof d.name === 'string' ? d.name : null,
        description: typeof d.description === 'string' ? d.description : null,
        parameters: 'parameters' in d ? d.parameters : null,
        raw: d,
      })
    }
  }
  return out
}

function extractCandidates(output: unknown): GeminiCandidate[] {
  if (!isPlainObject(output)) return []
  const raw = output.candidates
  if (!Array.isArray(raw)) return []
  return raw.map((c, i) => {
    if (!isPlainObject(c)) {
      return {
        content: null,
        finish_reason: null,
        safety_ratings: null,
        citation_metadata: null,
        index: i,
        raw: { candidate: c } as Record<string, unknown>,
      }
    }
    const content = isPlainObject(c.content)
      ? {
          role: typeof c.content.role === 'string' ? c.content.role : 'model',
          parts: Array.isArray(c.content.parts) ? c.content.parts : [],
        }
      : null
    const finish_reason =
      typeof c.finish_reason === 'string'
        ? c.finish_reason
        : typeof c.finishReason === 'string'
          ? c.finishReason
          : null
    const safety_ratings = Array.isArray(c.safety_ratings)
      ? c.safety_ratings
      : Array.isArray(c.safetyRatings)
        ? c.safetyRatings
        : null
    const citation_metadata =
      'citation_metadata' in c
        ? c.citation_metadata
        : 'citationMetadata' in c
          ? c.citationMetadata
          : null
    const index = typeof c.index === 'number' ? c.index : i
    return { content, finish_reason, safety_ratings, citation_metadata, index, raw: c }
  })
}

function lastUserIdx(turns: GeminiTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'user') return i
  }
  return -1
}

// ---- views ----

function CandidateView({
  candidate,
  total,
  index,
}: {
  candidate: GeminiCandidate
  total: number
  index: number
}): ReactNode {
  const captions: string[] = []
  if (total > 1) captions.push(`candidate ${index + 1} of ${total}`)
  if (candidate.finish_reason && candidate.finish_reason !== 'STOP') {
    captions.push(`finish: ${candidate.finish_reason}`)
  }
  const parts = candidate.content?.parts ?? []
  return (
    <Message
      role={roleFromGemini(candidate.content?.role ?? 'model')}
      initiallyOpen
      summary={summarisePartList(parts)}
      caption={captions.length > 0 ? captions.join(' · ') : undefined}
      content={
        <div className="space-y-2 text-sm">
          {renderParts(parts)}
          {candidate.finish_reason === 'SAFETY' && parts.length === 0 && (
            <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900">
              <span className="mr-2 font-medium uppercase tracking-wide text-red-700">
                Blocked
              </span>
              The model declined to respond due to safety filters.
            </p>
          )}
          <SafetyRatingsDisclosure ratings={candidate.safety_ratings} />
          {candidate.citation_metadata !== null && candidate.citation_metadata !== undefined && (
            <div className="rounded border border-warm bg-warm/10 p-2 text-xs">
              <h5 className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
                Citations
              </h5>
              <HumanValue value={candidate.citation_metadata} />
            </div>
          )}
        </div>
      }
    />
  )
}

function SafetyRatingsDisclosure({ ratings }: { ratings: unknown[] | null }): ReactNode {
  if (!ratings || ratings.length === 0) return null
  const interesting = ratings.filter((r) => {
    if (!isPlainObject(r)) return false
    const p = typeof r.probability === 'string' ? r.probability : null
    return r.blocked === true || (p !== null && p !== 'NEGLIGIBLE')
  })
  if (interesting.length === 0) return null
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[11px] text-text-muted">
        <span className="uppercase tracking-wide">Safety</span>{' '}
        <span className="font-mono">{interesting.length}</span> non-NEGLIGIBLE rating
        {interesting.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-1 ml-3 list-disc space-y-0.5">
        {interesting.map((r, i) => {
          if (!isPlainObject(r)) return null
          const cat = typeof r.category === 'string' ? r.category : '(unknown)'
          const p = typeof r.probability === 'string' ? r.probability : ''
          const blocked = r.blocked === true ? ' · blocked' : ''
          return (
            <li key={i} className="font-mono">
              {cat}: {p}
              {blocked}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

function renderParts(parts: unknown[]): ReactNode {
  if (parts.length === 0) {
    return <span className="text-text-muted italic text-xs">(no parts)</span>
  }
  return (
    <div className="space-y-2">
      {parts.map((p, i) => (
        <GeminiPart key={i} part={p} />
      ))}
    </div>
  )
}

function GeminiPart({ part }: { part: unknown }): ReactNode {
  if (!isPlainObject(part)) return <HumanValue value={part} />
  if (typeof part.text === 'string') {
    // Structured-output content from `response_mime_type: 'application/json'`
    // arrives as a JSON-encoded string. Render the structured value, not
    // the raw JSON text.
    const parsed = tryParseStructuredString(part.text)
    if (
      parsed !== part.text &&
      (Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object'))
    ) {
      return <HumanValue value={parsed} />
    }
    return <p className="whitespace-pre-wrap break-words">{part.text}</p>
  }
  const inline = pickField(part, 'inline_data', 'inlineData')
  if (isPlainObject(inline)) {
    return renderInlineData(inline)
  }
  const file = pickField(part, 'file_data', 'fileData')
  if (isPlainObject(file)) {
    return renderFileData(file)
  }
  const fnCall = pickField(part, 'function_call', 'functionCall')
  if (isPlainObject(fnCall)) {
    return <FunctionCallBlock call={fnCall} />
  }
  const fnResp = pickField(part, 'function_response', 'functionResponse')
  if (isPlainObject(fnResp)) {
    return <FunctionResponseBlock response={fnResp} />
  }
  // Code execution + thought blocks fall through to HumanValue.
  return <HumanValue value={part} />
}

function renderInlineData(inline: Record<string, unknown>): ReactNode {
  const mime =
    typeof inline.mime_type === 'string'
      ? inline.mime_type
      : typeof inline.mimeType === 'string'
        ? inline.mimeType
        : 'application/octet-stream'
  const data = typeof inline.data === 'string' ? inline.data : null
  if (!data) return <HumanValue value={inline} />
  const uri = data.startsWith('data:') ? data : `data:${mime};base64,${data}`
  if (mime.startsWith('image/')) {
    return <ClickableImage src={uri} alt="image attachment" className="max-h-32 max-w-xs" />
  }
  if (mime.startsWith('audio/')) {
    return <audio controls src={uri} className="h-8 max-w-xs" />
  }
  return (
    <span className="inline-flex items-baseline gap-2 rounded bg-warm/40 px-2 py-1 text-xs">
      <span className="font-medium uppercase tracking-wide text-text-muted">File</span>
      <span className="font-mono text-[10px]">{mime}</span>
    </span>
  )
}

function renderFileData(file: Record<string, unknown>): ReactNode {
  const mime =
    typeof file.mime_type === 'string'
      ? file.mime_type
      : typeof file.mimeType === 'string'
        ? file.mimeType
        : null
  const uri =
    typeof file.file_uri === 'string'
      ? file.file_uri
      : typeof file.fileUri === 'string'
        ? file.fileUri
        : null
  return (
    <span className="inline-flex items-baseline gap-2 rounded bg-warm/40 px-2 py-1 text-xs">
      <span className="font-medium uppercase tracking-wide text-text-muted">File</span>
      {mime && <span className="font-mono text-[10px]">{mime}</span>}
      {uri && (
        <a
          href={uri}
          target="_blank"
          rel="noopener noreferrer"
          className="cursor-pointer break-all text-forest underline"
        >
          {uri}
        </a>
      )}
    </span>
  )
}

function FunctionCallBlock({ call }: { call: Record<string, unknown> }): ReactNode {
  const name = typeof call.name === 'string' ? call.name : null
  const args = 'args' in call ? call.args : null
  return (
    <div className="rounded border border-forest/30 bg-forest/5 p-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-forest/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-forest">
          Tool call
        </span>
        {name && <span className="font-mono text-[11px] font-medium">{name}</span>}
      </div>
      {args !== null && args !== undefined && (
        <div className="mt-1.5">
          <HumanValue value={args} />
        </div>
      )}
    </div>
  )
}

function FunctionResponseBlock({ response }: { response: Record<string, unknown> }): ReactNode {
  const name = typeof response.name === 'string' ? response.name : null
  const body = 'response' in response ? response.response : null
  return (
    <div className="rounded border border-warm bg-warm/30 p-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded bg-warm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-dark">
          Tool result
        </span>
        {name && <span className="font-mono text-[11px] font-medium">{name}</span>}
      </div>
      {body !== null && body !== undefined && (
        <div className="mt-1.5">
          <HumanValue value={body} />
        </div>
      )}
    </div>
  )
}

function ToolsSection({ tools }: { tools: FunctionDeclaration[] }): ReactNode {
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

function ToolDef({ tool }: { tool: FunctionDeclaration }): ReactNode {
  if (!tool.name) return <HumanValue value={tool.raw} />
  return (
    <div className="rounded border border-warm bg-white px-2 py-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[11px] font-medium text-forest">{tool.name}</span>
        {tool.description && (
          <span className="text-[11px] text-text-muted">{tool.description}</span>
        )}
      </div>
      {tool.parameters !== null && tool.parameters !== undefined && (
        <div className="mt-1 text-[11px]">
          <HumanValue value={tool.parameters} />
        </div>
      )}
    </div>
  )
}

function summarisePartList(parts: unknown[]): string {
  for (const p of parts) {
    if (!isPlainObject(p)) continue
    if (typeof p.text === 'string') return summariseContent(p.text)
    if (pickField(p, 'function_call', 'functionCall')) {
      const fc = pickField(p, 'function_call', 'functionCall')
      if (isPlainObject(fc) && typeof fc.name === 'string') return `tool call: ${fc.name}`
      return 'tool call'
    }
    if (pickField(p, 'function_response', 'functionResponse')) return 'tool result'
    if (pickField(p, 'inline_data', 'inlineData')) return 'image'
    if (pickField(p, 'file_data', 'fileData')) return 'file'
  }
  return parts.length === 0 ? '(empty)' : '(structured)'
}

function roleFromGemini(role: string): MessageRole {
  if (role === 'user') return 'user'
  if (role === 'model' || role === 'assistant') return 'assistant'
  if (role === 'system') return 'system'
  if (role === 'tool' || role === 'function') return 'tool'
  return 'unknown'
}

function pickField(obj: unknown, snake: string, camel: string): unknown {
  if (!isPlainObject(obj)) return undefined
  if (snake in obj && obj[snake] !== undefined) return obj[snake]
  if (camel in obj && obj[camel] !== undefined) return obj[camel]
  return undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
