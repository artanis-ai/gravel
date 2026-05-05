/**
 * `gravel manifest --check` (used by pre-commit hook) and
 * `gravel manifest --update`.
 */
import { fastScan, diffManifests } from '../manifest/scan.js'
import { readManifest, writeManifest } from '../manifest/io.js'

export async function runManifestCheck(): Promise<void> {
  const cwd = process.cwd()
  const current = await readManifest(cwd)
  const result = await fastScan(cwd, current)

  // Compare new manifest to on-disk one
  const inSync =
    result.added === 0 && result.removed === 0 && result.changed === 0
  if (!inSync) {
    const diff = diffManifests(current, result.manifest)
    console.error('Gravel manifest is out of date:')
    console.error(diff)
    process.exit(1)
  }
  console.log('Gravel manifest is in sync.')
}

export async function runManifestUpdate(opts: { printOnly?: boolean } = {}): Promise<void> {
  const cwd = process.cwd()
  const current = await readManifest(cwd)
  const result = await fastScan(cwd, current)

  if (opts.printOnly) {
    console.log(`Manifest: ${result.manifest.prompts.length} prompts`)
    for (const p of result.manifest.prompts) {
      console.log(
        `  ${p.path}` + (p.type === 'embedded' ? ` (line ${p.lineStart}-${p.lineEnd})` : ''),
      )
    }
    return
  }

  await writeManifest(cwd, result.manifest)
  console.log(
    `Manifest updated: +${result.added} -${result.removed} ~${result.changed} (${result.unchanged} unchanged).`,
  )
}
