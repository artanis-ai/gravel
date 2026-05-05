/**
 * Read / write the manifest file.
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { Manifest, MANIFEST_PATH, MANIFEST_VERSION, emptyManifest } from './types.js'

export async function readManifest(repoRoot: string): Promise<Manifest> {
  const path = join(repoRoot, MANIFEST_PATH)
  try {
    const raw = await fs.readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Manifest
    if (parsed.version !== MANIFEST_VERSION) {
      throw new Error(
        `[gravel] Manifest version ${parsed.version} not supported by this SDK ` +
          `(expected ${MANIFEST_VERSION}). Update @artanis/gravel.`,
      )
    }
    return parsed
  } catch (e: any) {
    if (e?.code === 'ENOENT') return emptyManifest()
    throw e
  }
}

export async function writeManifest(repoRoot: string, manifest: Manifest): Promise<void> {
  const path = join(repoRoot, MANIFEST_PATH)
  await fs.mkdir(dirname(path), { recursive: true })
  // Pretty-printed for human review in PRs.
  await fs.writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
}
