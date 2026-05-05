/**
 * Hash normalization for prompt content. Whitespace differences shouldn't
 * change a hash. Spec: gravel-cloud/docs/spec/manifest.md §4.
 *
 * Identical to python/gravel/src/artanis_gravel/manifest/hash.py — kept in sync.
 */
import { createHash } from 'node:crypto'

export function normalize(text: string): string {
  // 1. Convert line endings to \n.
  let normalized = text.replace(/\r\n?/g, '\n')
  // 2. Strip trailing whitespace on each line.
  normalized = normalized
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
  // 3. Strip leading + trailing blank lines.
  normalized = normalized.replace(/^(\s*\n)+/, '').replace(/(\n\s*)+$/, '')
  return normalized
}

export function hashPrompt(text: string): string {
  return 'sha256:' + createHash('sha256').update(normalize(text)).digest('hex')
}

/**
 * Stable ID for a prompt entry. Generated once at first detection and persists
 * thereafter (path-rename-safe).
 */
export function generatePromptId(path: string, charStart?: number): string {
  const seed = `${path}:${charStart ?? 'file'}:${process.hrtime.bigint()}:${Math.random()}`
  // 8-char prefix is plenty for collision avoidance within one repo.
  return 'p_' + createHash('sha1').update(seed).digest('hex').slice(0, 12)
}
