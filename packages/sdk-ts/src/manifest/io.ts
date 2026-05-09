/**
 * Read / write the manifest file.
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LEGACY_MANIFEST_PATH,
  MANIFEST_PATH,
  MANIFEST_VERSION,
  emptyManifest,
} from './types.js'
import type { Manifest } from './types.js'

export async function readManifest(repoRoot: string): Promise<Manifest> {
  // Try the canonical `.gravel/` path first; fall back to `.artanis/`
  // for installs that pre-date the 2026-05-09 rename. See
  // types.ts :: LEGACY_MANIFEST_PATH.
  for (const rel of [MANIFEST_PATH, LEGACY_MANIFEST_PATH]) {
    const path = join(repoRoot, rel)
    try {
      const raw = await fs.readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as Manifest
      if (parsed.version !== MANIFEST_VERSION) {
        throw new Error(
          `[gravel] Manifest version ${parsed.version} not supported by this SDK ` +
            `(expected ${MANIFEST_VERSION}). Update @artanis-ai/gravel.`,
        )
      }
      return parsed
    } catch (e: any) {
      if (e?.code === 'ENOENT') continue
      throw e
    }
  }
  return emptyManifest()
}

export async function writeManifest(repoRoot: string, manifest: Manifest): Promise<void> {
  const path = join(repoRoot, MANIFEST_PATH)
  await fs.mkdir(dirname(path), { recursive: true })
  // Pretty-printed for human review in PRs.
  await fs.writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
}
