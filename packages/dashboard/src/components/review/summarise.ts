/**
 * Summarisation helpers for the Message collapsed-state preview.
 *
 * Renderers call these to compute the one-line `summary` shown next
 * to the role chip while a message bubble is collapsed. Mirrors the
 * dashboard's pre-Phase-3 `summarizeBlocks` behaviour: lead with
 * any prose, otherwise surface a marker for the block type.
 */

const MAX = 80

/** Reduce arbitrary message content into a short preview. Handles
 *  the four common shapes we see across providers:
 *    - bare string
 *    - array of content parts (OpenAI / Anthropic / LC blocks)
 *    - LC message dict (we read `content`)
 *    - `null` / `undefined` → "(empty)"
 *  Falls back to "(empty)" when nothing meaningful is extractable. */
export function summariseContent(content: unknown): string {
  if (content === null || content === undefined) return '(empty)'
  if (typeof content === 'string') return truncate(collapseWhitespace(content))
  if (typeof content === 'number' || typeof content === 'boolean') {
    return truncate(String(content))
  }
  if (Array.isArray(content)) return summariseBlocks(content)
  if (isPlainObject(content)) {
    // LC message dicts have `content` and a `type` discriminator.
    if ('content' in content) return summariseContent(content.content)
    return '(structured)'
  }
  return '(empty)'
}

function summariseBlocks(blocks: unknown[]): string {
  for (const block of blocks) {
    if (!isPlainObject(block)) {
      if (typeof block === 'string') return truncate(collapseWhitespace(block))
      continue
    }
    const type = typeof block.type === 'string' ? block.type : null
    // Prose-y blocks across providers: OpenAI `text` / `output_text`,
    // Anthropic `text`, LC `text`.
    if (type === 'text' || type === 'output_text' || type === 'reasoning') {
      if (typeof block.text === 'string') return truncate(collapseWhitespace(block.text))
    }
    // Refusal block — short, render as the prefix the reviewer expects.
    if (type === 'refusal') {
      const r = typeof block.refusal === 'string' ? block.refusal : ''
      return truncate(`refusal: ${collapseWhitespace(r)}`)
    }
    // Tool call (OpenAI tool_call content part or Anthropic tool_use).
    if (type === 'tool_use' || type === 'tool_call') {
      const name = typeof block.name === 'string' ? block.name : null
      return name ? `tool call: ${name}` : 'tool call'
    }
    // Tool result on the user side (Anthropic) or top-level (OpenAI).
    if (type === 'tool_result') {
      return block.is_error === true ? 'tool result · error' : 'tool result'
    }
    // Image / audio / file / document blocks.
    if (type === 'image' || type === 'image_url') return 'image'
    if (type === 'input_audio' || type === 'audio') return 'audio'
    if (type === 'file') return 'file'
    if (type === 'document') return 'document'
  }
  return '(structured)'
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function truncate(s: string): string {
  if (s.length <= MAX) return s
  return s.slice(0, MAX) + '…'
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
