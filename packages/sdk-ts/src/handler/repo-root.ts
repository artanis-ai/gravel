/**
 * Where to read the manifest / prompt files from.
 *
 * Honors `GRAVEL_REPO_ROOT` so a dev running the dashboard's HMR Vite
 * server (whose `process.cwd()` is `packages/dashboard`) can point it
 * at their actual app's repo root and see real prompts. In production,
 * this is the customer's app cwd.
 */
export function repoRoot(): string {
  return process.env.GRAVEL_REPO_ROOT ?? process.cwd()
}
