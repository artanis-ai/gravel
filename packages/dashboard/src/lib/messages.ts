/**
 * Normalize the wire-format messages we see across providers into a
 * single shape the dialog can render uniformly.
 *
 * Sources we cover:
 *   - OpenAI Chat Completions (the most common; system / user /
 *     assistant / tool roles; content can be string OR an array of
 *     parts of type text / image_url / input_audio / file; assistant
 *     message can carry tool_calls; tool messages have tool_call_id).
 *     https://platform.openai.com/docs/api-reference/chat
 *   - OpenAI Responses API (input items + output items, with
 *     input_text / input_image / input_file / function_call /
 *     function_call_output).
 *     https://platform.openai.com/docs/api-reference/responses
 *   - Anthropic Messages (content blocks of type text / image /
 *     tool_use / tool_result / document).
 *     https://docs.anthropic.com/claude/reference/messages_post
 *   - Vercel AI SDK (parts of type text / reasoning / file /
 *     tool-call / tool-result; assistant message also surfaces
 *     `toolCalls` / `toolResults` directly).
 *     https://sdk.vercel.ai/docs
 *   - Raw fetch traces wrapping any of the above as
 *     `{ url, method, body }` (the gravel SDK's fallback patcher).
 *
 * Anything we don't recognise becomes a `unknown` block carrying the
 * raw payload — the renderer prints it as JSON so nothing is lost.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; url?: string; mediaType?: string; alt?: string; rawSize?: number }
  | { type: 'file'; name?: string; mediaType?: string; url?: string; rawSize?: number }
  | { type: 'tool_call'; id?: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId?: string; output: unknown; isError?: boolean }
  | { type: 'unknown'; raw: unknown }

export interface NormalizedMessage {
  /** system / user / assistant / tool / function / developer / etc. */
  role: string
  blocks: ContentBlock[]
  /** Raw original — kept so a "show JSON" toggle works without re-parsing. */
  raw: unknown
}

/** Pull a chat-message array out of common request shapes. Tolerant. */
export function extractMessages(input: unknown): NormalizedMessage[] {
  if (!input || typeof input !== 'object') return []
  // Raw-fetch wrapping: { url, method, body }
  const obj = input as Record<string, unknown>
  let body: Record<string, unknown> = obj
  if (obj.body && typeof obj.body === 'object') {
    body = obj.body as Record<string, unknown>
  }
  // OpenAI Responses API uses `input` (string or array of items).
  if (Array.isArray(body.input)) {
    return body.input.map((item) => normalizeMessage(item))
  }
  if (typeof body.input === 'string') {
    return [{ role: 'user', blocks: [{ type: 'text', text: body.input }], raw: body.input }]
  }
  // Anthropic + OpenAI Chat Completions: messages array.
  if (Array.isArray(body.messages)) {
    const msgs = body.messages.map((m) => normalizeMessage(m))
    // Anthropic separates system into its own field.
    const system = body.system
    if (typeof system === 'string') {
      msgs.unshift({ role: 'system', blocks: [{ type: 'text', text: system }], raw: system })
    } else if (Array.isArray(system)) {
      msgs.unshift({ role: 'system', blocks: normalizeContent(system), raw: system })
    }
    return msgs
  }
  // Vercel AI SDK sometimes nests under prompt / messages.
  if (Array.isArray(body.prompt)) {
    return body.prompt.map((m) => normalizeMessage(m))
  }
  return []
}

/** Pull the assistant turn(s) out of common response shapes. */
export function extractOutput(output: unknown): NormalizedMessage[] {
  if (output == null) return []
  if (typeof output === 'string') {
    return [{ role: 'assistant', blocks: [{ type: 'text', text: output }], raw: output }]
  }
  if (typeof output !== 'object') {
    return [{ role: 'assistant', blocks: [{ type: 'text', text: String(output) }], raw: output }]
  }
  const obj = output as Record<string, unknown>

  // OpenAI Chat Completions: { choices: [{ message: { role, content, tool_calls } }] }
  if (Array.isArray(obj.choices)) {
    return obj.choices
      .map((c) => {
        if (!c || typeof c !== 'object') return null
        const msg = (c as Record<string, unknown>).message
        if (msg && typeof msg === 'object') return normalizeMessage(msg)
        const text = (c as Record<string, unknown>).text
        if (typeof text === 'string') {
          return { role: 'assistant', blocks: [{ type: 'text', text }] as ContentBlock[], raw: c }
        }
        return null
      })
      .filter((m): m is NormalizedMessage => m !== null)
  }

  // Anthropic Messages: { role: 'assistant', content: [...] }
  if (Array.isArray(obj.content)) {
    return [
      {
        role: typeof obj.role === 'string' ? obj.role : 'assistant',
        blocks: normalizeContent(obj.content),
        raw: output,
      },
    ]
  }

  // OpenAI Responses API: { output: [...] }
  if (Array.isArray(obj.output)) {
    return obj.output.map((item) => normalizeMessage(item))
  }

  // Vercel AI: top-level `text`, `reasoning`, `toolCalls`, `toolResults`.
  const parts: ContentBlock[] = []
  if (typeof obj.reasoning === 'string') parts.push({ type: 'reasoning', text: obj.reasoning })
  if (typeof obj.text === 'string') parts.push({ type: 'text', text: obj.text })
  if (Array.isArray(obj.toolCalls)) {
    for (const tc of obj.toolCalls) parts.push(toToolCallBlock(tc))
  }
  if (Array.isArray(obj.toolResults)) {
    for (const tr of obj.toolResults) parts.push(toToolResultBlock(tr))
  }
  if (parts.length > 0) {
    return [{ role: 'assistant', blocks: parts, raw: output }]
  }

  return [{ role: 'assistant', blocks: [{ type: 'unknown', raw: output }], raw: output }]
}

function normalizeMessage(raw: unknown): NormalizedMessage {
  if (!raw || typeof raw !== 'object') {
    return { role: 'unknown', blocks: [{ type: 'unknown', raw }], raw }
  }
  const obj = raw as Record<string, unknown>
  const role = typeof obj.role === 'string' ? obj.role : (typeof obj.type === 'string' ? obj.type : 'unknown')
  // OpenAI Chat Completions assistant tool_calls live alongside content.
  const blocks = normalizeContent(obj.content)
  if (Array.isArray(obj.tool_calls)) {
    for (const tc of obj.tool_calls) blocks.push(toToolCallBlock(tc))
  }
  // OpenAI tool message → tool_result block. role === 'tool' & tool_call_id.
  if (role === 'tool' && typeof obj.tool_call_id === 'string') {
    return {
      role,
      blocks: [
        {
          type: 'tool_result',
          toolCallId: obj.tool_call_id,
          output: obj.content ?? null,
        },
      ],
      raw,
    }
  }
  // OpenAI Responses API items — function_call / function_call_output.
  if (obj.type === 'function_call') {
    return {
      role: 'assistant',
      blocks: [
        toToolCallBlock({
          id: obj.call_id ?? obj.id,
          name: obj.name,
          arguments: obj.arguments,
        }),
      ],
      raw,
    }
  }
  if (obj.type === 'function_call_output') {
    return {
      role: 'tool',
      blocks: [
        {
          type: 'tool_result',
          toolCallId: typeof obj.call_id === 'string' ? obj.call_id : undefined,
          output: obj.output ?? null,
        },
      ],
      raw,
    }
  }
  return { role, blocks, raw }
}

function normalizeContent(content: unknown): ContentBlock[] {
  if (content == null) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'unknown', raw: content }]
  const out: ContentBlock[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      out.push({ type: 'text', text: part })
      continue
    }
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    const type = typeof p.type === 'string' ? p.type : ''

    // ---- Text variants ----
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = (p.text ?? '') as string
      if (typeof text === 'string') out.push({ type: 'text', text })
      continue
    }
    if (type === 'reasoning' || type === 'thinking') {
      const text = (p.text ?? p.thinking ?? '') as string
      if (typeof text === 'string') out.push({ type: 'reasoning', text })
      continue
    }

    // ---- Images ----
    if (type === 'image_url') {
      // OpenAI: { type: 'image_url', image_url: { url, detail? } }
      const iu = p.image_url
      const url = typeof iu === 'string' ? iu : iu && typeof iu === 'object' ? ((iu as Record<string, unknown>).url as string | undefined) : undefined
      out.push({ type: 'image', url })
      continue
    }
    if (type === 'input_image' || type === 'image') {
      // OpenAI Responses API: { type: 'input_image', image_url: '...' }
      // Anthropic: { type: 'image', source: { type: 'base64', media_type, data } | { type: 'url', url } }
      const iu = p.image_url
      const src = p.source as Record<string, unknown> | undefined
      let url: string | undefined
      let mediaType: string | undefined
      let rawSize: number | undefined
      if (typeof iu === 'string') url = iu
      else if (iu && typeof iu === 'object') {
        url = (iu as Record<string, unknown>).url as string | undefined
      }
      if (src) {
        if (typeof src.url === 'string') url = src.url
        if (typeof src.media_type === 'string') mediaType = src.media_type
        if (typeof src.mediaType === 'string') mediaType = src.mediaType
        if (typeof src.data === 'string') {
          // Convert base64 to a data URL so the <img> can render it.
          const mt = mediaType ?? 'image/png'
          url = `data:${mt};base64,${src.data}`
          rawSize = (src.data as string).length
        }
      }
      out.push({ type: 'image', url, mediaType, rawSize })
      continue
    }

    // ---- Files / documents ----
    if (type === 'file' || type === 'input_file' || type === 'document') {
      const file = (p.file ?? p.source) as Record<string, unknown> | undefined
      let url: string | undefined
      let name: string | undefined
      let mediaType: string | undefined
      let rawSize: number | undefined
      if (file) {
        if (typeof file.url === 'string') url = file.url
        if (typeof file.file_url === 'string') url = file.file_url as string
        if (typeof file.filename === 'string') name = file.filename
        if (typeof file.media_type === 'string') mediaType = file.media_type
        if (typeof file.mediaType === 'string') mediaType = file.mediaType
        // OpenAI Chat Completions inline file part: `file.file_data`
        // is base64. Older variants used `file.data`.
        const inlineData =
          typeof file.file_data === 'string'
            ? (file.file_data as string)
            : typeof file.data === 'string'
              ? (file.data as string)
              : undefined
        if (inlineData) {
          // Strip an existing data: prefix if the upstream already
          // pre-formatted one (OpenAI accepts `file_data` either way).
          const m = inlineData.match(/^data:([^;]+);base64,(.*)$/)
          if (m) {
            mediaType = mediaType ?? m[1]!
            url = inlineData
            rawSize = m[2]!.length
          } else {
            const mt = mediaType ?? 'application/octet-stream'
            url = `data:${mt};base64,${inlineData}`
            rawSize = inlineData.length
          }
        }
      }
      // Vercel-AI file part: { type: 'file', mediaType, data | url, filename? }
      if (typeof p.data === 'string') {
        const mt = (p.mediaType as string | undefined) ?? mediaType ?? 'application/octet-stream'
        url = `data:${mt};base64,${p.data}`
        rawSize = (p.data as string).length
      }
      if (typeof p.url === 'string') url = p.url
      if (typeof p.mediaType === 'string') mediaType = p.mediaType
      if (typeof p.filename === 'string') name = p.filename
      out.push({ type: 'file', url, name, mediaType, rawSize })
      continue
    }

    // ---- Tool calls / results ----
    if (type === 'tool_use' || type === 'tool-call') {
      out.push(toToolCallBlock(p))
      continue
    }
    if (type === 'tool_result' || type === 'tool-result') {
      out.push(toToolResultBlock(p))
      continue
    }

    // Anthropic 4.5 audio etc — punt.
    out.push({ type: 'unknown', raw: part })
  }
  return out
}

function toToolCallBlock(raw: unknown): ContentBlock {
  if (!raw || typeof raw !== 'object') return { type: 'unknown', raw }
  const r = raw as Record<string, unknown>
  // OpenAI Chat Completions: { id, type: 'function', function: { name, arguments } }
  const fn = r.function as Record<string, unknown> | undefined
  let name = ''
  let input: unknown = null
  if (fn) {
    name = typeof fn.name === 'string' ? fn.name : ''
    const args = fn.arguments
    if (typeof args === 'string') {
      try {
        input = JSON.parse(args)
      } catch {
        input = args
      }
    } else input = args ?? null
  } else {
    name = typeof r.name === 'string' ? r.name : (typeof r.toolName === 'string' ? r.toolName : '')
    // Anthropic + Vercel: input lives directly on the block.
    if ('input' in r) input = r.input
    else if ('args' in r) input = r.args
    else if ('arguments' in r) {
      const args = r.arguments
      if (typeof args === 'string') {
        try {
          input = JSON.parse(args)
        } catch {
          input = args
        }
      } else input = args ?? null
    }
  }
  const id = typeof r.id === 'string' ? r.id : typeof r.toolCallId === 'string' ? r.toolCallId : undefined
  return { type: 'tool_call', id, name, input }
}

function toToolResultBlock(raw: unknown): ContentBlock {
  if (!raw || typeof raw !== 'object') return { type: 'unknown', raw }
  const r = raw as Record<string, unknown>
  const toolCallId =
    typeof r.tool_use_id === 'string'
      ? r.tool_use_id
      : typeof r.toolCallId === 'string'
        ? r.toolCallId
        : typeof r.tool_call_id === 'string'
          ? r.tool_call_id
          : undefined
  // Anthropic: content is array of text blocks; OpenAI tool message: content string.
  let output: unknown
  if ('output' in r) output = r.output
  else if ('result' in r) output = r.result
  else if ('content' in r) {
    const c = r.content
    if (Array.isArray(c)) {
      output = c
        .map((part) => {
          if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
            return (part as Record<string, unknown>).text
          }
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
    } else output = c
  }
  const isError = r.is_error === true || r.isError === true
  return { type: 'tool_result', toolCallId, output: output ?? null, isError }
}
