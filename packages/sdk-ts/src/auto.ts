/**
 * Import-side-effect entry point: `import '@artanis-ai/gravel/auto'`.
 *
 * Boots tracing by detecting installed LLM provider clients and patching them.
 * Honours GRAVEL_TRACING_DISABLED=1.
 *
 * Spec: gravel-cloud/docs/spec/tracing.md §1, §2
 *
 * BLOCKER: provider patches not implemented yet. This file currently only
 * sets up the "scaffolding" — it logs which providers it would have patched
 * and is otherwise a no-op. Real patches land alongside v1.
 */
const DISABLED = process.env.GRAVEL_TRACING_DISABLED === '1'

if (DISABLED) {
  // eslint-disable-next-line no-console
  console.log('[gravel] tracing disabled via GRAVEL_TRACING_DISABLED=1')
} else {
  void detectAndPatch()
}

async function detectAndPatch(): Promise<void> {
  const detected: string[] = []
  for (const pkg of ['openai', '@anthropic-ai/sdk', 'langchain', 'ai']) {
    try {
      // require.resolve isn't available in ESM; use dynamic import + catch.
      // We don't actually load the modules yet — just probe presence.
      await import(/* @vite-ignore */ pkg)
      detected.push(pkg)
    } catch {
      /* not installed */
    }
  }
  if (detected.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[gravel] tracing scaffolding active for: ${detected.join(', ')} ` +
        `(BLOCKER: provider patches not yet implemented — see github.com/artanis-ai/gravel)`,
    )
  }
}
