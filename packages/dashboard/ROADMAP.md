# Dashboard rendering roadmap

> Deferred work surfaced by the Phase-1 (v0.6.0) audit. None of this
> blocks the v0.6.0 release. Captured here so the next time we touch
> the renderers we know what we already learned.
>
> The Phase-1 catalogue (`SOURCES.md`) is the source of truth for what
> v0.6.0 actually handles. This document is for what comes after.

## Approximately 85 additional fixture variants

These are payload shapes the providers document but we don't yet have
fixtures for. Each one currently falls through to the `HumanValue`
fallback renderer — which is human-readable but suboptimal — instead
of getting a dedicated render path. None of them are critical for the
v0.6.0 launch; add them as customer usage drives prioritisation.

### OpenAI Chat Completions

- Audio output: `message.audio: {id, expires_at, data, transcript}`,
  `content: null`
- Audio input content part: `{type: 'input_audio', input_audio: {data, format}}`
- File input content part: `{type: 'file', file: {filename, file_data} | {file_id}}`
- Populated `logprobs`: `choices[i].logprobs.content[]` with
  `{token, logprob, bytes, top_logprobs[]}`
- `n > 1` multiple `choices[]` per response
- `response_format: {type: 'json_schema', ...}` structured output
  (output `message.content` is a JSON-encoded string)
- `response_format: {type: 'json_object'}` legacy JSON mode
- Populated reasoning / cached / audio / accepted_prediction /
  rejected_prediction token detail fields in
  `usage.completion_tokens_details` and `usage.prompt_tokens_details`
- `finish_reason: 'content_filter'` and `'length'`
- Web-search annotations: `message.annotations[].url_citation`
- Streaming with `stream_options.include_usage` (final chunk has
  empty `choices: []` + populated `usage`)

### OpenAI Responses API

The OutputItem union has 24 variants; we render 3 with dedicated paths.
The rest:

- `reasoning` item (o-series / gpt-5 default output) with
  `summary[].summary_text`, optional `content[].reasoning_text`,
  optional `encrypted_content`, `status` — **highest priority
  follow-up** because every reasoning-model trace hits this
- `web_search_call` item + accompanying `url_citation` annotations
  on `output_text`
- `file_search_call` item with `queries[]` + `results[]`
- `computer_call` + paired `computer_call_output` containing
  `computer_screenshot`
- `code_interpreter_call` with `container_id`, `code`, `outputs[]`
- `image_generation_call` with `result` (base64 PNG)
- `mcp_call`, `mcp_list_tools`, `mcp_approval_request`,
  `mcp_approval_response`
- `local_shell_call` / `local_shell_call_output`
- `apply_patch_tool_call`
- `custom_tool_call` (free-form / non-JSON args)
- `output_text` with populated `annotations[]` (`file_citation`,
  `url_citation`, `container_file_citation`, `file_path`)
- `output_text.logprobs` populated
- `refusal` content item (Responses-API analogue of Chat's refusal)
- `status: 'incomplete'` + `incomplete_details: {reason}`
- `status: 'failed'` + top-level `error: {code, message}`
- `previous_response_id` chaining
- Responses-API streaming events (`response.output_item.added`,
  `response.output_text.delta`, `response.completed` etc.)

### OpenAI Embeddings

- `encoding_format: 'base64'` (data is a base64 string, not float
  array — current renderer would mishandle)
- `dimensions` parameter (shortened embedding arrays)
- Array-of-token-arrays input (batched pre-tokenized)

### Anthropic Messages

- **Prompt caching**: `cache_control` on `system[]`, `tools[]`,
  message text blocks, and `tool_result` blocks; usage with
  `cache_creation_input_tokens` / `cache_read_input_tokens` /
  `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`
- **Extended thinking**: `thinking` content block with `signature`;
  `redacted_thinking` block; `thinking.display: 'omitted'` variant;
  `thinking.type: 'adaptive'` (Opus 4.7); streaming `thinking_delta`
  and `signature_delta` events
- **Built-in tools**: `tool_use` of type `bash_20250124` /
  `text_editor_20250728` / `computer_20251124` — **HumanValue
  fallback acceptable** (rare in our customer base today)
- **Server tools**: `server_tool_use` block, `web_search_tool_result`
  (success with `web_search_result` content + error with
  `web_search_tool_result_error`), `code_execution_tool_result` +
  `bash_code_execution_tool_result` +
  `text_editor_code_execution_tool_result`, MCP connector
  (`mcp_tool_use` / `mcp_tool_result`, `mcp_servers` request field)
  — **HumanValue fallback acceptable**
- Citation types: `page_location`, `content_block_location`,
  `web_search_result_location`, `search_result_location` (we only
  render `char_location` today)
- Image source variants: `{type: 'url', url}` and
  `{type: 'file', file_id}` (we only render base64)
- PDF document blocks (`{type: 'document', source: {type: 'base64',
  media_type: 'application/pdf', data}}`)
- `search_result` content block + `container_upload` block
- `tool_result.content` as an array of mixed blocks (text + image)
  rather than a plain string
- `stop_reason`: `pause_turn`, `refusal`, `max_tokens`,
  `stop_sequence` (we have `end_turn` + the errored case)
- Top-level `service_tier`, `metadata.user_id`, `container` fields
- Streaming events: `input_json_delta`, `citations_delta`, `ping`,
  inline `error` events
- **Messages Batches API** (`POST /v1/messages/batches`) —
  **HumanValue fallback acceptable** (no Gravel customer uses this
  today)

### Vercel AI

- Multimodal `messages[].content` as array of typed parts (`text`,
  `image`, `file`, `tool-call`, `tool-result`, `reasoning`,
  `redacted-reasoning`)
- Multi-step agent runs with `steps[]` (each step has its own
  `text`, `toolCalls`, `toolResults`, `finishReason`, `usage`) +
  top-level `totalUsage` vs per-step `usage`
- `generateObject` output modes beyond `object`: `array`, `enum`,
  `no-schema`
- `streamObject` array mode (`elementStream`)
- Reasoning model fields: `reasoning[]`, `reasoningText`,
  `usage.reasoningTokens`,
  `usage.outputTokenDetails.reasoningTokens`
- `sources[]` (search-grounded responses): `{sourceType: 'url', id,
  url, title?, providerMetadata?}`
- `files[]` (multimodal output, e.g. Gemini image-out)
- `warnings[]` on response
- `providerMetadata` on response, content parts, and sources
- Top-level `content: ContentPart[]` array on response
- Request/response metadata block: `request: {body}`,
  `response: {id, modelId, timestamp, headers?, messages[], body?}`
- Tool error case: `toolResults` item with `isError: true`
- Tool choice variants: `'required'`, `{type: 'tool', toolName}`,
  `'none'`

### LangChain

- AIMessage with populated `tool_calls: [{name, args, id, type:
  'tool_call'}]`
- `ToolMessage` (`type: 'tool'`) with `content`, `tool_call_id`,
  `name`, optional `artifact`
- `AIMessageChunk` (streaming): `tool_call_chunks: [{name, args, id,
  index, type: 'tool_call_chunk'}]`
- Multimodal `HumanMessage.content` as array of blocks. The
  **canonical form is now flat** (`{type: 'image', url}` /
  `{type: 'image', base64, mime_type}` / `{type: 'audio', ...}` /
  `{type: 'video', ...}` / `{type: 'file', ...}`), not the
  OpenAI-flavoured `{type: 'image_url', image_url: {url}}`. The
  renderer should accept both for back-compat with older LC
  serialisations, but the canonical fixture should use the flat form.
- `invalid_tool_calls: [{name, args, id, error, type:
  'invalid_tool_call'}]`
- New trace kinds — currently dropped at the SDK callback handler.
  See "SDK capture bugs" below.
- LangGraph node runs: inputs/outputs are the state dict directly,
  not wrapped in `{state: dict}`
- Agent `structured_response`: structured output now surfaces at
  `result["structured_response"]` of the agent state, not in
  `additional_kwargs.parsed`
- JS callback variants (camelCase: `additionalKwargs`,
  `responseMetadata`, `toolCalls`, `toolCallId`, `usageMetadata`)
- `batch([...])` Runnable input — multiple parallel chain runs in
  the outer dimension
- `usage_metadata` detail subobjects: `input_token_details:
  {audio, cache_read, cache_creation}`, `output_token_details:
  {audio, reasoning}`
- Production `additional_kwargs` payloads: `function_call`
  (deprecated), `tool_calls` (deprecated mirror), `parsed`,
  `refusal`, `reasoning_content` (DeepSeek/o1-style)
- `ChatGenerationChunk` (streaming flavour of `ChatGeneration`)

## SDK capture bugs surfaced by the audit

These are bugs (the SDK is silently losing data the provider sent),
not just missing fixtures. None blocks the v0.6.0 release — the
fields that DO get captured render correctly — but each one means
some customer trace is missing context the reviewer would want.

1. **LangChain handler is missing `on_tool_*` and `on_retriever_*`
   hooks.** Both are first-class `BaseCallbackHandler` events that
   produce their own runs. Today we silently drop them. Need two
   new trace kinds: `langchain.tool` and `langchain.retriever`.
   Python AND TS handlers.

2. **Anthropic streaming persistence is inconsistent across
   languages.** Python persists `output: {chunks: [...]}` (full SSE
   event list); TS persists `output: {text, chunk_count}` (collapsed
   text). Different fixtures needed for the two stacks, and the
   renderer can't dispatch a single way. Converge on: `output:
   <assembled Message>` (same shape as non-streaming) +
   `metadata.states[]` containing chunk count, timestamps, and the
   distinctive event types observed (e.g. saw `input_json_delta` /
   `citations_delta` / `thinking_delta`).

3. **OpenAI Responses streaming chunk shape is mislabelled.** Our
   chunk collector assumes Chat-Completions stream events
   (`choices[].delta`). The Responses API uses a different shape
   (`response.output_item.added`, `response.output_text.delta`,
   `response.completed`). Customers streaming the Responses API
   still get usable chunk dumps but the SDK should detect the API
   variant and store the chunk shape under a distinct key.

4. **Anthropic streaming `input_json_delta` and `citations_delta`
   events.** The Python SDK does capture every chunk (`_safe_dump`
   over the iterator), so these aren't dropped today — but TS
   collapses the chunk list into `{text, chunk_count}` and loses
   them. Fix as part of #2.

5. **OpenAI error wire-shape support in the fetch path.** Customers
   calling OpenAI via raw `fetch` (not the SDK) get the wire-shape
   error response `{error: {message, type, code, param}}` when the
   provider returns 4xx/5xx. Our fetch tracer currently captures
   `output = {status, statusText}` and discards the body. The renderer
   should be able to show provider-side error context, so the fetch
   tracer should preserve the parsed error body on non-2xx
   responses (and the renderer dispatch should treat it as an
   errored variant of the provider's normal shape).

## Major LLM providers / frameworks NOT instrumented today

Tracked separately as roadmap items. We catch OpenAI-compatible
third parties (Groq / Together / Fireworks / DeepInfra / Perplexity /
xAI / DeepSeek / OpenRouter / Azure OpenAI / vLLM / LM Studio /
LiteLLM proxies) via the path-based fetch tracer. Direct patches do
not exist for:

- **Google Gemini** (`google-generativeai` Python /
  `@google/generative-ai` TS / Vertex AI SDK) — top priority
- **AWS Bedrock** (`boto3.client('bedrock-runtime')` /
  `@aws-sdk/client-bedrock-runtime`)
- **Ollama** (`ollama` SDK / direct HTTP) in native mode
  (`/api/chat`, `/api/generate`) — caught in OpenAI-compat mode
- **Cohere** (`cohere` SDK)
- **Mistral** (`mistralai`) — partial via fetch tracer (caught as
  `fetch:openai.chat.completions` but Mistral-specific fields like
  `safe_prompt` are lost)
- **Replicate** (`replicate` SDK)
- **LlamaIndex** (Python + TS) — second-biggest RAG framework
- **DSPy** — growing fast in research/eval
- **CrewAI** / **AutoGen** — multi-agent space
- **Haystack** — enterprise RAG

Recommended prioritisation (in order): Gemini, Bedrock, Ollama,
LlamaIndex. Cohere/Mistral are nice-to-have. The rest are watch-list.

## Decision log

- **MCP / computer-use / image-generation / code-interpreter /
  Anthropic Batches API**: catalogued but not handled with dedicated
  renderers — HumanValue fallback is acceptable until customer
  usage justifies the work.
- **Vercel AI v3 / camelCase naming back-compat**: dropped. We
  haven't shipped v0.6.0 yet so there is no installed-customer base
  to support. Wrappers + fixtures + renderers use the current
  (v4+) naming exclusively.
