/**
 * Import-side-effect entry point: `import '@artanis-ai/gravel/auto'`.
 *
 * Boots tracing by detecting installed LLM provider clients and patching them.
 * Honours GRAVEL_TRACING_DISABLED=1.
 *
 *
 * Each provider module's top-level code is responsible for try-importing the
 * third-party package and silently no-op-ing if it isn't installed. That keeps
 * this entrypoint a thin orchestrator.
 */
const DISABLED = process.env.GRAVEL_TRACING_DISABLED === '1'

if (DISABLED) {
  // eslint-disable-next-line no-console
  console.log('[gravel] tracing disabled via GRAVEL_TRACING_DISABLED=1')
} else {
  // Side-effect imports — each module patches what it can find.
  void import('./tracing/openai.js')
  void import('./tracing/anthropic.js')
  void import('./tracing/langchain.js')
  void import('./tracing/vercel-ai.js')
  // Last so SDK-level patches take precedence: SDKs route through fetch
  // internally, but the SDK patcher already records that call and we don't
  // want a duplicate. The classifier only matches LLM-shaped paths, so
  // non-LLM fetch calls are passed through untouched.
  void import('./tracing/fetch.js')
}
