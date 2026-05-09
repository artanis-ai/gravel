/**
 * Pill labelling whether a prompt lives in its own file or as an embedded
 * literal inside source code. Mirrors `manifest.md` types.
 */
import { Badge } from '../Badge'
import type { PromptType } from '../../lib/types'

export function PromptBadge({ type }: { type: PromptType }) {
  // File-type is the default — only badge embedded prompts, where the
  // varName/inline-literal context is meaningful info.
  if (type === 'file') return null
  return <Badge tone="neutral">embedded</Badge>
}
