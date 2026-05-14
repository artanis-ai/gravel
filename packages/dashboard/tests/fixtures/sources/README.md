# Fixtures: one canonical payload per tracing source

Every JSON file here is a `gravel_samples` row shape that one of our
tracing patches actually writes. The file format is:

```json
{
  "name": "<the value of gravel_samples.name>",
  "description": "<what's special about this fixture>",
  "source": "<the SourceKind detectSource() returns>",
  "isFetch": false,
  "status": "completed",
  "input": <gravel_samples.input>,
  "output": <gravel_samples.output>,
  "metadata": <gravel_samples.metadata>
}
```

`source` is the renderer dispatch key. `detectSource(name, input,
output)` must produce this value for every fixture in this directory —
that's the pinning test in `lib/source.test.ts`.

## Provenance

| Fixture | Source |
|---|---|
| `langchain-chain-*.json` | Real captures from `landlord-ai/gravel.db`, anonymised |
| `openai-chat.json` | Aligned with the OpenAI Chat Completions API docs |
| `anthropic-messages.json` | Aligned with the Anthropic Messages API docs |
| Other `openai-*` / `anthropic-*` | Aligned with provider docs |
| `vercel-ai-*` | Aligned with the Vercel AI SDK docs + `packages/sdk-ts/tests/tracing-vercel-ai.test.ts` fixture shapes |
| `langchain-llm.json` / `langchain-chat-model.json` | Aligned with `python/gravel/tests/test_tracing_langchain.py` |
| `fetch-*.json` | Wrap a payload above in `{url, method, headers, body: ...}` / `{status, body: ...}` |
| `state-observations.json` / `error-observation.json` / `custom-metadata.json` / `multi-step-trace.json` | Synthesised to cover the cross-cutting cases |

## When updating

If a new provider field becomes load-bearing (e.g. a new content block
type lands in Anthropic), add a new fixture for that variant. Don't
mutate existing fixtures unless the SDK's wire format itself
changes — they're the regression pin for the renderers that handle
them.
