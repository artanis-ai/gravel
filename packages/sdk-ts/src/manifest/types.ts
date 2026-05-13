/**
 * `.gravel/manifest.json` schema. §2.
 */

export const MANIFEST_VERSION = 1
export const MANIFEST_PATH = '.gravel/manifest.json'

export type PromptType = 'file' | 'embedded'

export interface PromptSegment {
  /** 1-indexed, inclusive */
  lineStart: number
  lineEnd: number
  /**
   * Unicode code-point offsets, half-open `[charStart, charEnd)` into
   * the file content. NOT UTF-16 code units (JS native) and NOT UTF-8
   * bytes (Go native). Use `sliceByCodePoints` from
   * `manifest/offsets.ts` to read/write; plain `.slice()` will chop
   * surrogate pairs on emoji and astral characters.
   */
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
