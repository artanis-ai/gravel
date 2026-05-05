/**
 * `gravel doctor` — self-diagnostic. Reports environment health.
 */
import { detect } from '../wizard/detect.js'
import { config as loadEnv } from '../wizard/load-env.js'
import { readManifest } from '../manifest/io.js'

export async function runDoctor(): Promise<void> {
  const cwd = process.cwd()
  const detection = await detect(cwd)
  const env = await loadEnv(cwd)
  const manifest = await readManifest(cwd).catch(() => null)

  console.log('Gravel doctor')
  console.log('─────────────')
  console.log(`Language:        ${detection.language}`)
  console.log(`Framework:       ${detection.framework}`)
  console.log(`Package manager: ${detection.packageManager}`)
  console.log(`Database driver: ${detection.database.driver} (env: ${detection.database.envVar ?? 'none'})`)
  console.log(`Auth provider:   ${detection.auth}`)
  console.log(`Existing tracers: ${detection.existingTracers.length ? detection.existingTracers.join(', ') : 'none'}`)
  console.log(`Git repo:        ${detection.hasGit ? 'yes' : 'no'}`)
  console.log(`Manifest:        ${manifest ? `${manifest.prompts.length} prompts` : 'missing'}`)
  console.log(`GRAVEL_PROJECT_ID: ${env.GRAVEL_PROJECT_ID ?? '<unset>'}`)
  console.log(`GRAVEL_API_KEY:    ${env.GRAVEL_API_KEY ? '<set>' : '<unset>'}`)
  console.log(`GRAVEL_ADMIN_PASSWORD: ${env.GRAVEL_ADMIN_PASSWORD ? '<set>' : '<unset>'}`)
  console.log(`GRAVEL_TRACING_DISABLED: ${env.GRAVEL_TRACING_DISABLED ?? '<unset>'}`)

  // BLOCKER: connectivity probes (DB, control plane, judge) once those exist.
}
