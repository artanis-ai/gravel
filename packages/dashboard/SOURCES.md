# Tracing source catalogue

> **Status:** v0.6.0. Dedicated renderers ship for every kind below. This
> document is the **source of truth** for every payload shape the Gravel
> SDK can land in `gravel_samples`. Every renderer round-trips the
> fixtures listed here without falling through to a raw-JSON dump.

## What this is

The Gravel SDK auto-patches a number of LLM providers and framework
adapters. Each patch writes a row to `gravel_samples` with three
JSON-ish columns the dashboard reads: `input`, `output`, `metadata`.
The shapes of those columns vary across providers, and across calls
of the same provider (streaming vs. one-shot, error vs. completed,
multimodal vs. plain).

Before v0.6.0 the dashboard had two tolerant generic functions
(`extractMessages` / `extractOutput` in `src/lib/messages.ts`) that
tried to recognise common chat shapes and fell back to a JSON dump
for anything they didn't. That fallback fired far more often than we
expected — the audit that found this was prompted by a customer
seeing `{"is_greeting": true}` rendered as a wall of quoted JSON in
the Review tab.

The fix: **explicit per-source dispatch**, driven by trace `name`
(or, where the name is ambiguous, by shape detection). One renderer
per logical source, each with its own fixture, unit test, snapshot
test, and Playwright visual baseline.

## Catalogue

Every entry below maps to a fixture in `tests/fixtures/sources/`.
The fixture is the canonical input/output/metadata shape — real
captures where available (extracted from `landlord-ai`'s
`gravel.db` or from the SDK's own `tracing-*.test.ts` suite), and
provider-doc-aligned mocks where not.

### OpenAI

| Trace name | Renderer | Fixtures |
|---|---|---|
| `openai.chat.completions.create` | `openai-chat` | `openai-chat.json` (text), `openai-chat-with-tools.json` (assistant tool_calls), `openai-chat-tool-result.json` (role=tool message), `openai-chat-multimodal.json` (image_url part), `openai-chat-refusal.json` (safety refusal), `openai-chat-error.json` (errored status) |
| `openai.responses.create` | `openai-responses` | `openai-responses.json` (item-based input + output), `openai-responses-function-call.json`, `openai-responses-function-call-output.json` |
| `openai.embeddings.create` | `openai-embeddings` | `openai-embeddings-single.json` (string input), `openai-embeddings-batch.json` (string array), `openai-embeddings-tokens.json` (token-id array input) |
| `fetch:openai.chat.completions` | `openai-chat` (after `{body}` unwrap) | `fetch-openai-chat.json` |
| `fetch:openai.responses` | `openai-responses` (after `{body}` unwrap) | covered by `openai-responses` set |
| `fetch:openai.embeddings` | `openai-embeddings` (after `{body}` unwrap) | covered by `openai-embeddings` set |

Notable nuances:
- **Token usage** lives at `output.usage` with the post-2024 breakdown
  fields: `prompt_tokens`, `completion_tokens`, `total_tokens`,
  `prompt_tokens_details.{cached_tokens, audio_tokens}`,
  `completion_tokens_details.{reasoning_tokens, audio_tokens,
  accepted_prediction_tokens, rejected_prediction_tokens}`.
- **Refusal** is `output.choices[0].message.refusal: string|null` — not
  the same as a content block; the renderer surfaces it distinctly.
- **logprobs** at `output.choices[0].logprobs` is currently dropped
  by the dashboard; renderer should offer an opt-in details disclosure.
- **Streaming**: when `stream: true`, the SDK persists `chunks` in
  `metadata.states` (or `metadata.observations`). The renderer must
  show that the call was streamed (separately from the assembled
  output).
- **multimodal `audio` output** (`output.choices[0].message.audio`)
  is a base64 audio payload + transcript. Renderer must surface both.

### Anthropic

| Trace name | Renderer | Fixtures |
|---|---|---|
| `anthropic.messages.create` | `anthropic-messages` | `anthropic-messages.json` (text), `anthropic-messages-system.json` (top-level `system` field), `anthropic-messages-with-tools.json` (tool_use blocks), `anthropic-messages-tool-result.json` (tool_result content blocks), `anthropic-messages-image.json` (base64 + url + document blocks), `anthropic-messages-citations.json` (citation blocks), `anthropic-messages-error.json` |
| `anthropic.messages.stream` (TS only) | `anthropic-messages` | `anthropic-messages-stream.json` (assembled output + chunks state) |
| `fetch:anthropic.messages` | `anthropic-messages` (after `{body}` unwrap) | `fetch-anthropic-messages.json` |

Notable nuances:
- **Top-level `system`** field on the request (string OR array of
  text/image blocks). Not a message — surfaced as a system message
  at the top of the conversation.
- **`stop_reason`** at `output.stop_reason`: `end_turn` /
  `max_tokens` / `stop_sequence` / `tool_use` / `pause_turn` /
  `refusal`. Renderer surfaces this distinctly when non-`end_turn`.
- **Token usage** at `output.usage`: `input_tokens`,
  `output_tokens`, plus newer `cache_creation_input_tokens` /
  `cache_read_input_tokens` (prompt caching).
- **`tool_use` blocks** vs `tool_result` blocks have distinct
  shapes (tool_result lives on a `user` role message).
- **Citation blocks** (`{type: 'text', citations: [...]}`) and
  **`web_search_tool_result`** / **`server_tool_use`** blocks are
  newer (2026-Q1) — renderer should at least pass through
  `HumanValue` if not rendered specifically.

### Vercel AI (TS only)

| Trace name | Renderer | Fixtures |
|---|---|---|
| `vercel-ai.generateText` | `vercel-ai-text` | `vercel-ai-generate-text.json` |
| `vercel-ai.streamText` | `vercel-ai-text` (assembled) | `vercel-ai-stream-text.json` |
| `vercel-ai.generateObject` | `vercel-ai-object` | `vercel-ai-generate-object.json` |
| `vercel-ai.streamObject` | `vercel-ai-object` (assembled) | `vercel-ai-stream-object.json` |

Notable nuances:
- **Token keys are v4+ camelCase**: `usage.inputTokens`,
  `usage.outputTokens`, `usage.totalTokens` (snake_case in
  OpenAI/Anthropic). The v3-era `promptTokens` / `completionTokens`
  names are NOT supported. We baselined the wrapper against v4+
  before shipping v0.6.0 to avoid carrying back-compat shims.
- **Tool calls / results use v4+ field names**: `tool_call.input`
  (not `args`), `tool_result.output` (not `result`); tool
  definitions use `inputSchema` (not `parameters`); multi-step
  control uses `stopWhen` (not `maxSteps`); response metadata uses
  `providerMetadata` (not `experimental_providerMetadata`).
- **generateObject output** is `{object: <generated value>, usage,
  finishReason}`, where `object` is the structured value the schema
  produced (rendered via `HumanValue` recursively).
- **toolCalls + toolResults** can land on either the assistant
  message or the top-level response; renderer normalises.
- **Wrapper captures but defers rendering** for: multi-step
  `steps[]`, reasoning-model `reasoning[]` / `reasoningText`,
  search-grounded `sources[]`, multimodal-out `files[]`,
  `warnings[]`, `providerMetadata`, top-level `content[]`,
  `request` / `response` metadata. All fall through to HumanValue
  until dedicated render paths land. See ROADMAP.md.

### Langchain

Python and TS use different naming conventions. The renderer dispatch
must accept both.

| Trace name (Python) | Trace name (TS) | Renderer | Fixtures |
|---|---|---|---|
| `langchain.llm` | `langchain.llm.<id>` | `langchain-llm` | `langchain-llm.json` (LLMResult with `generations[][]` shape) |
| `langchain.chat_model` | `langchain.chat.<id>` | `langchain-chat-model` | `langchain-chat-model.json` (messages-in, ChatResult-out) |
| `langchain.chain` | `langchain.chain.<id>` | `langchain-chain` | `langchain-chain-messages.json` (inputs.messages), `langchain-chain-single-message.json` (inputs is a single LC message), `langchain-chain-structured-output.json` (`{is_greeting: true}`), `langchain-chain-vars-and-messages.json` (`inputs: {var1, messages}`), `langchain-chain-string-value.json` (`{value: "x"}`) |
| `langchain.tool` | `langchain.tool.<id>` | `langchain-tool` | `langchain-tool.json` (`{input_str, serialized, tool}` → `{value}`) |
| `langchain.retriever` | `langchain.retriever.<id>` | `langchain-retriever` | `langchain-retriever.json` (`{query, serialized}` → `{documents: [{page_content, metadata}], count}`) |

Notable nuances:
- LC messages use `type` (not `role`) with values `human` / `ai` /
  `system` / `tool` / `function` / `chat`. Renderer maps to standard
  roles.
- LC messages carry `additional_kwargs` (often `{parsed: ...}` or
  `{tool_calls: [...]}`) and `response_metadata` (token_usage,
  model_name, finish_reason, system_fingerprint). Renderer folds
  these into the message rather than rendering them as separate keys.
- LC chain `inputs` is open-shape — could be a list of messages, a
  dict with a `messages` field, a dict of template variables, or a
  single LC message. Renderer handles each by detection.
- LC `LLMResult.generations` is `Array<Array<Generation>>` —
  outer array is per-input, inner is per-completion. Renderer
  surfaces multi-prompt batches distinctly from `n>1` completions.

### Raw fetch fallback

| Trace name | Renderer | Fixtures |
|---|---|---|
| `fetch:openai.chat.completions` | unwrap `{body}` → `openai-chat` | `fetch-openai-chat.json` |
| `fetch:openai.responses` | unwrap `{body}` → `openai-responses` | `fetch-openai-responses.json` |
| `fetch:openai.embeddings` | unwrap `{body}` → `openai-embeddings` | `fetch-openai-embeddings.json` |
| `fetch:anthropic.messages` | unwrap `{body}` → `anthropic-messages` | `fetch-anthropic-messages.json` |

Notable nuances:
- Input wrapped as `{url, method, headers, body: <provider request>}`.
  Renderer must NOT lose the URL/method (surfaced as a small header
  strip above the chat) — this is the only way to distinguish a
  customer's direct HTTP call from an SDK call.
- Output wrapped as `{status, body: <provider response>}`.
  Non-2xx `status` flips into the error renderer path.

### Cross-cutting concerns

These are not source-specific but apply across all renderers:

1. **State observations** (`metadata.states`) — streaming chunk
   summaries, intermediate steps. Fixture: `state-observations.json`.
   Renderer: a collapsible "Stream chunks: 27" section under the
   output, with the chunk list available on expand.
2. **Error observations** (`metadata.error: {message, type}`,
   `status: 'errored'`) — fixture: `error-observation.json`.
   Renderer: red-tinted panel above the (often empty) output, with
   the error message + type + stack if present.
3. **Custom user metadata** (set via `with_gravel_metadata({...})`)
   — fixture: `custom-metadata.json`. Renderer: surfaces
   user-provided keys above the SDK-provided ones in the metadata
   strip.
4. **Multi-step traces** (`sample.group_id` non-null) — fixture:
   `multi-step-trace.json` plus the `related` array on the detail
   response. Renderer: a "Trace: 3 steps" navigator at the top of
   the dialog letting the reviewer hop between samples in the trace.
5. **Feedback rendering** — feedback rows with `correction` text
   should render the correction as the same kind of rich content as
   the assistant message it corrects (not as raw text).

## Detection algorithm

```
detectSource(name: string, input: unknown, output: unknown): SourceKind

  1. Strip a `fetch:` prefix from `name`. If present, also unwrap
     `body` from input/output and remember `isFetch=true` so the
     URL + status get surfaced in the render.
  2. Match exact: openai.chat.completions.create →
     'openai-chat'; openai.responses.create →
     'openai-responses'; openai.embeddings.create →
     'openai-embeddings'; anthropic.messages.create or
     anthropic.messages.stream → 'anthropic-messages'.
  3. Match prefix:
     - vercel-ai.generateText | streamText → 'vercel-ai-text'
     - vercel-ai.generateObject | streamObject → 'vercel-ai-object'
     - langchain.chat | langchain.chat_model → 'langchain-chat-model'
     - langchain.llm → 'langchain-llm'
     - langchain.chain → 'langchain-chain'
  4. Fall through: 'unknown'. Renderer = HumanValue. Never JSON dump.
```

Test pinning: `lib/source.test.ts` runs `detectSource` against every
fixture in `tests/fixtures/sources/` and asserts it returns the kind
declared in that fixture's `source` field. Any new fixture that
doesn't have a renderer will fail the test.

## Renderer contract

Every per-source renderer exports:

```ts
export interface SourceRenderProps {
  input: unknown
  output: unknown
  metadata: Record<string, unknown> | null
  status: 'completed' | 'errored' | 'running'
}

export function OpenAIChatRenderer(props: SourceRenderProps): JSX.Element
```

Each renderer:
- Composes the small primitives (`<ChatBubble>`, `<TokenStrip>`,
  `<ErrorPanel>`, `<HumanValue>`).
- Renders an empty/missing field as the matching empty-state copy
  (`<EmptyState kind="output" />`) — never `(none)` or `null`.
- Never falls through to a `<pre>` JSON dump for ANY value. If a
  shape isn't recognised, descend into `<HumanValue>` (which itself
  has zero JSON fallbacks).
- Has at least one unit test (vitest), one snapshot test, one
  Playwright screenshot baseline.

## Phase boundaries

This document gets updated at the close of each phase with what's
landed and what's still outstanding. **Treat the table at the top
as the source of truth** for what the renderer dispatch covers; this
document's row count must not exceed `detectSource()`'s actual
support.

| Phase | Status |
|---|---|
| 1. Catalogue + fixtures | _in progress_ |
| 2. Primitives + dispatch shell | not started |
| 3. Renderers (Chat / Anthropic / LC Chat / LC Chain) | not started |
| 4. Renderers (Responses / Embeddings / Vercel / LC LLM / fetch) | not started |
| 5. Cross-cutting (state / error / streaming / metadata / multi-step / refusal) | not started |
| 6. Playwright screenshot baselines + landlord-ai QA | not started |
| 7. Lockstep release v0.6.0 + STATUS update | not started |

## Customer footprint

This rewrite changes **zero** wizard-emitted files in the customer's
codebase. The dashboard reads the existing `gravel_samples` row
shape; no schema migration, no new SDK call required of the user.
All renderer work is internal to `packages/dashboard/src/`. The
wizard continues to install the same `gravel_route.py` /
`gravel.config.ts` it always did.
