/**
 * `.gravel/manifest.json` schema. See gravel-cloud/docs/spec/manifest.md §2.
 *
 * Renamed from `.artanis/` 2026-05-09 — the SDK is `gravel`, the
 * hidden directory should match the product name. Existing
 * installs with `.artanis/` keep working; `readManifest` falls back
 * to that path when `.gravel/` is missing, and the wizard's hook +
 * pre-commit installer migrates on next run.
 */

export const MANIFEST_VERSION = 1
export const MANIFEST_PATH = '.gravel/manifest.json'
/**
 * Legacy path. `readManifest` falls back here when `MANIFEST_PATH`
 * isn't found, so existing customers don't need to migrate manually.
 * Remove once we're confident nobody's running pre-rename installs.
 */
export const LEGACY_MANIFEST_PATH = '.artanis/manifest.json'

export type PromptType = 'file' | 'embedded'

export interface PromptSegment {
  /** 1-indexed, inclusive */
  lineStart: number
  lineEnd: number
  /** 0-indexed byte offsets, half-open [charStart, charEnd) into the file */
  charStart: number
  charEnd: number
  /** Variable / constant name (best-effort) */
  varName?: string
}

export interface ManifestPromptFile {
  id: string
  type: 'file'
  path: string
  hash: string
}

export interface ManifestPromptEmbedded {
  id: string
  type: 'embedded'
  path: string
  hash: string
  lineStart: number
  lineEnd: number
  charStart: number
  charEnd: number
  varName?: string
}

export type ManifestPrompt = ManifestPromptFile | ManifestPromptEmbedded

export interface Manifest {
  version: number
  lastFullScanCommit: string | null
  lastFullScanAt: string | null // ISO timestamp
  prompts: ManifestPrompt[]
}

export function emptyManifest(): Manifest {
  return {
    version: MANIFEST_VERSION,
    lastFullScanCommit: null,
    lastFullScanAt: null,
    prompts: [],
  }
}
