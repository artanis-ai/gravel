/**
 * `gravel scan --deep` — LLM-assisted prompt detection. Walks the
 * source tree, identifies prompt strings inside code, and merges them
 * into `.artanis/manifest.json`.
 *
 * Costs the customer's OpenAI quota directly (no Artanis billing —
 * this is a free local tool). The regex `fastScan` covers most cases;
 * deep scan is for prompts hidden in dynamically-built strings.
 *
 * Spec: gravel-cloud/docs/spec/manifest.md §3.
 */
import { deepScan } from '../manifest/deep-scan.js'
import { readManifest, writeManifest } from '../manifest/io.js'
import { config as loadEnv } from '../wizard/load-env.js'

export async function runDeepScan(opts: { printOnly?: boolean } = {}): Promise<void> {
  const cwd = process.cwd()
  const env = await loadEnv(cwd)
  const apiKey = env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error(
      '[gravel] OPENAI_API_KEY not set. Deep scan calls OpenAI from your dev machine. Set it in .env or skip with `gravel manifest --update` (regex scan only).',
    )
    process.exit(1)
  }
  const current = await readManifest(cwd)

  console.log('[gravel] Deep scan starting (this hits the OpenAI API; one call per source file with potential prompts)')
  let scanned = 0
  const result = await deepScan(cwd, current, {
    apiKey,
    onFile: (p) => {
      scanned++
      if (scanned % 10 === 0) console.log(`  ...${scanned} files`)
      void p
    },
  })

  console.log('')
  console.log(`Files scanned: ${result.filesScanned}`)
  console.log(`Files skipped: ${result.filesSkipped}`)
  console.log(`New prompts:   ${result.newFindings.length}`)
  if (result.errors.length > 0) {
    console.log(`Errors:        ${result.errors.length}`)
    for (const e of result.errors.slice(0, 10)) {
      console.log(`  ${e.path}: ${e.message}`)
    }
    if (result.errors.length > 10) {
      console.log(`  …and ${result.errors.length - 10} more`)
    }
  }

  if (result.newFindings.length > 0) {
    console.log('')
    console.log('Discovered:')
    for (const f of result.newFindings) {
      const tag = f.varName ? `${f.varName} ` : ''
      const why = f.why ? ` — ${f.why}` : ''
      console.log(`  ${f.path}:${f.lineStart}-${f.lineEnd} ${tag}${why}`)
    }
  }

  if (opts.printOnly) {
    console.log('')
    console.log('--print-only: manifest left unchanged')
    return
  }

  if (result.newFindings.length === 0) {
    console.log('')
    console.log('Manifest already up to date — nothing to write.')
    return
  }

  await writeManifest(cwd, result.manifest)
  console.log('')
  console.log(`Manifest updated (+${result.newFindings.length} embedded prompts).`)
}
