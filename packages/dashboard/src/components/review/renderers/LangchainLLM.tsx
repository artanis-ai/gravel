/**
 * LangchainLLM — renderer for `langchain.llm` (Python) and
 * `langchain.llm.<runnable-id>` (TS). The raw-text counterpart to
 * `langchain.chat_model`: input is a list of prompt strings, output
 * is an LLMResult with generations grouped per prompt.
 *
 * Input shape:
 *   - `prompts: string[]` — the prompts the LLM was called with
 *   - `serialized` — LC's dump of the LLM config (model + kwargs)
 *   - `invocation_params?`, `options?`, `batch_size?`
 *
 * Output shape:
 *   - `generations: Array<Array<{text, generation_info?}>>`
 *     (one inner array per prompt; n>1 → multiple per prompt)
 *   - `llm_output: {token_usage?, model_name?, ...}`
 */
import { HumanValue } from '../HumanValue'
import { Message } from '../Message'
import type { Renderer } from '../types'
import { summariseContent } from '../summarise'

export const LangchainLLMRenderer: Renderer = ({ input, output }) => {
  const prompts = extractPrompts(input)
  const config = extractConfig(input)
  const generations = extractGenerations(output)

  const inputPane = (
    <div className="space-y-2">
      {prompts.map((p, i) => (
        <Message
          key={`prompt-${i}`}
          role="user"
          initiallyOpen={i === prompts.length - 1}
          summary={summariseContent(p)}
          caption={prompts.length > 1 ? `prompt ${i + 1} of ${prompts.length}` : undefined}
          content={<p className="whitespace-pre-wrap break-words text-sm">{p}</p>}
        />
      ))}
      {config && (
        <div className="rounded border border-warm bg-warm/10 p-3 text-xs">
          <h5 className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">
            LLM config
          </h5>
          <HumanValue value={config} />
        </div>
      )}
    </div>
  )

  const outputPane =
    generations.length === 0 ? null : (
      <div className="space-y-2">
        {generations.map((batch, b) => (
          <section key={`out-${b}`} className="space-y-1.5">
            {generations.length > 1 && (
              <h5 className="text-[10px] uppercase tracking-wide text-text-muted">
                Prompt {b + 1} of {generations.length}
              </h5>
            )}
            {batch.map((gen, i) => (
              <Message
                key={`gen-${b}-${i}`}
                role="assistant"
                initiallyOpen
                summary={summariseContent(gen.text)}
                caption={
                  batch.length > 1
                    ? `completion ${i + 1} of ${batch.length}${gen.finish_reason ? ` · ${gen.finish_reason}` : ''}`
                    : gen.finish_reason && gen.finish_reason !== 'stop'
                      ? `finish: ${gen.finish_reason}`
                      : undefined
                }
                content={
                  gen.text === null || gen.text.length === 0 ? (
                    <span className="text-text-muted italic">(empty)</span>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-sm">{gen.text}</p>
                  )
                }
              />
            ))}
          </section>
        ))}
      </div>
    )

  return { input: inputPane, output: outputPane }
}

// ---- extraction ----

interface Generation {
  text: string | null
  finish_reason: string | null
}

function extractPrompts(input: unknown): string[] {
  if (!isPlainObject(input)) return []
  const prompts = input.prompts
  if (!Array.isArray(prompts)) return []
  return prompts.filter((p): p is string => typeof p === 'string')
}

function extractConfig(input: unknown): Record<string, unknown> | null {
  if (!isPlainObject(input)) return null
  // Surface the LLM configuration so reviewers can see temperature,
  // model, max_tokens, etc. without dumping the entire input.
  const config: Record<string, unknown> = {}
  if (isPlainObject(input.serialized)) {
    const s = input.serialized
    if (isPlainObject(s.kwargs)) Object.assign(config, s.kwargs)
    else config.serialized = s
  }
  if (isPlainObject(input.invocation_params)) {
    Object.assign(config, input.invocation_params)
  }
  if (isPlainObject(input.options)) {
    const opts = input.options
    for (const [k, v] of Object.entries(opts)) {
      if (v !== null && v !== undefined) config[k] = v
    }
  }
  return Object.keys(config).length > 0 ? config : null
}

function extractGenerations(output: unknown): Generation[][] {
  if (!isPlainObject(output)) return []
  const generations = output.generations
  if (!Array.isArray(generations)) return []
  return generations.map((batch) => {
    if (!Array.isArray(batch)) return []
    return batch.map((g) => normaliseGeneration(g))
  })
}

function normaliseGeneration(raw: unknown): Generation {
  if (!isPlainObject(raw)) return { text: null, finish_reason: null }
  const text = typeof raw.text === 'string' ? raw.text : null
  const genInfo = isPlainObject(raw.generation_info) ? raw.generation_info : null
  const finish_reason =
    genInfo && typeof genInfo.finish_reason === 'string' ? genInfo.finish_reason : null
  return { text, finish_reason }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
