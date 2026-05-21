/**
 * Source detection for the Review surface.
 *
 * Every persisted sample row is one of a small number of provider
 * shapes (OpenAI Chat / Responses / Embeddings, Anthropic Messages,
 * Gemini, Vercel AI text / object, Langchain LLM / chat_model / chain)
 * or a raw-fetch wrap of one of those. `detectSource` reads `name`
 * (and shape-checks `input` / `output` where the name is ambiguous)
 * and returns a `SourceKind` discriminator. The Review surface then
 * dispatches to the matching renderer.
 *
 * The fixture directory at `tests/fixtures/sources/` pins every
 * supported (name, input, output) shape; `source.test.ts` iterates
 * those fixtures and asserts `detectSource` agrees with the declared
 * `source` field. New variants are added by writing a fixture, not
 * by editing this file.
 */

export type SourceKind =
  | 'openai-chat'
  | 'openai-responses'
  | 'openai-embeddings'
  | 'anthropic-messages'
  | 'gemini-chat'
  | 'vercel-ai-text'
  | 'vercel-ai-object'
  | 'langchain-llm'
  | 'langchain-chat-model'
  | 'langchain-chain'
  | 'langchain-tool'
  | 'langchain-retriever'
  | 'unknown'

/** Result of `unwrapFetch`: the inner provider payload plus the
 *  HTTP envelope. For SDK calls (non-fetch), `isFetch` is false and
 *  `input` / `output` are the original values. */
export interface FetchEnvelope {
  isFetch: boolean
  url?: string
  method?: string
  status?: number
  statusText?: string
  input: unknown
  output: unknown
}

/** Strip the `fetch:` SDK prefix from a trace name. Returns the
 *  prefix-less name plus a flag indicating whether it WAS fetched. */
export function stripFetchPrefix(name: string): { name: string; isFetch: boolean } {
  if (name.startsWith('fetch:')) return { name: name.slice('fetch:'.length), isFetch: true }
  return { name, isFetch: false }
}

/** Unwrap the `{url, method, body}` / `{status, statusText?, body}`
 *  wrapper our fetch tracer puts around raw HTTP calls. Returns the
 *  inner provider payload + the URL / method / status for the
 *  renderer to display in the header strip.
 *
 *  Idempotent for non-fetch samples (just returns `input` / `output`
 *  untouched with `isFetch: false`). */
export function unwrapFetch(
  name: string,
  input: unknown,
  output: unknown,
): FetchEnvelope {
  const { isFetch } = stripFetchPrefix(name)
  if (!isFetch) {
    return { isFetch: false, input, output }
  }
  const inObj = isPlainObject(input) ? input : undefined
  const outObj = isPlainObject(output) ? output : undefined
  return {
    isFetch: true,
    url: typeof inObj?.url === 'string' ? inObj.url : undefined,
    method: typeof inObj?.method === 'string' ? inObj.method : undefined,
    status: typeof outObj?.status === 'number' ? outObj.status : undefined,
    statusText: typeof outObj?.statusText === 'string' ? outObj.statusText : undefined,
    input: inObj && 'body' in inObj ? inObj.body : input,
    output: outObj && 'body' in outObj ? outObj.body : output,
  }
}

/** Map a trace `name` (and, when the name is ambiguous, the
 *  payload shape) to a `SourceKind`. Returns `'unknown'` when no
 *  renderer claims the shape — the Review surface falls back to
 *  the recursive `HumanValue` for unknowns rather than dumping JSON. */
export function detectSource(name: string, _input: unknown, _output: unknown): SourceKind {
  const { name: stripped } = stripFetchPrefix(name)

  // Exact matches.
  if (stripped === 'openai.chat.completions.create') return 'openai-chat'
  if (stripped === 'openai.chat.completions') return 'openai-chat'
  if (stripped === 'openai.responses.create') return 'openai-responses'
  if (stripped === 'openai.responses') return 'openai-responses'
  if (stripped === 'openai.embeddings.create') return 'openai-embeddings'
  if (stripped === 'openai.embeddings') return 'openai-embeddings'
  if (stripped === 'anthropic.messages.create') return 'anthropic-messages'
  if (stripped === 'anthropic.messages.stream') return 'anthropic-messages'
  if (stripped === 'anthropic.messages.parse') return 'anthropic-messages'
  if (stripped === 'anthropic.messages') return 'anthropic-messages'

  // Gemini (Google's `google-genai` Python SDK and `@google/genai` JS SDK).
  // Trace name is canonical snake_case across both stacks, matching the
  // OpenAI / Anthropic convention.
  if (stripped === 'gemini.models.generate_content') return 'gemini-chat'
  if (stripped === 'gemini.models.generate_content_stream') return 'gemini-chat'
  if (stripped === 'gemini.models') return 'gemini-chat'

  // Vercel AI: `vercel-ai.generateText` / `streamText` / `generateObject` / `streamObject`.
  if (stripped === 'vercel-ai.generateText') return 'vercel-ai-text'
  if (stripped === 'vercel-ai.streamText') return 'vercel-ai-text'
  if (stripped === 'vercel-ai.generateObject') return 'vercel-ai-object'
  if (stripped === 'vercel-ai.streamObject') return 'vercel-ai-object'

  // Langchain: Python uses bare names (`langchain.chain`),
  // TS uses `langchain.<kind>.<runnable-id>`. Prefix match handles both.
  if (stripped === 'langchain.llm' || stripped.startsWith('langchain.llm.')) {
    return 'langchain-llm'
  }
  if (
    stripped === 'langchain.chat_model' ||
    stripped.startsWith('langchain.chat.') ||
    stripped.startsWith('langchain.chat_model.')
  ) {
    return 'langchain-chat-model'
  }
  if (stripped === 'langchain.chain' || stripped.startsWith('langchain.chain.')) {
    return 'langchain-chain'
  }
  if (stripped === 'langchain.tool' || stripped.startsWith('langchain.tool.')) {
    return 'langchain-tool'
  }
  if (stripped === 'langchain.retriever' || stripped.startsWith('langchain.retriever.')) {
    return 'langchain-retriever'
  }

  return 'unknown'
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
