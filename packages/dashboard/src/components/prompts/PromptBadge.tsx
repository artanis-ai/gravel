/**
 * Pill labelling whether a prompt lives in its own file or as an embedded
 * literal inside source code. Mirrors `manifest.md` types.
 */
import { Badge } from '../Badge'
import type { PromptType } from '../../lib/types'

export function PromptBadge({ type }: { type: PromptType }) {
  if (type === 'file') return <Badge tone="info">file</Badge>
  return <Badge tone="neutral">embedded</Badge>
}
