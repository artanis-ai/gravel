/**
 * Shared TypeScript types for dashboard payloads.
 *
 * Mirrors the backend route shapes in
 * `packages/sdk-ts/src/handler/routes.ts` and the schema in
 * `packages/sdk-ts/src/schema/`.
 *
 * Vocabulary: traces are "samples" (one row per LLM call). A multi-step
 * trace is samples sharing a group_id. Datasets + evals + observations +
 * per-user types are not on the customer-side data plane today.
 */

export type SampleStatus = 'running' | 'completed' | 'errored'

export interface SampleListItem {
  id: string
  name: string
  model: string | null
  environment: string | null
  status: SampleStatus
  group_id: string | null
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  feedback_count: number
  feedback_score: 'positive' | 'negative' | 'mixed' | null
}

export interface SamplesResponse {
  samples: SampleListItem[]
  total: number
  page: number
  page_size: number
}

export interface FeedbackItem {
  id: string
  sample_id: string
  comment: string | null
  correction: string | null
  score: 'positive' | 'negative' | 'neutral' | null
  reporter_user_id: string | null
  created_at: string
}

export interface SampleDetailResponse {
  sample: SampleListItem & {
    commit_sha: string | null
    input: unknown
    output: unknown
    metadata: Record<string, unknown> | null
  }
  feedback: FeedbackItem[]
  /** Other samples sharing this sample's group_id. Empty for single-shot. */
  related: SampleListItem[]
}


// ---------- Prompts ----------
//
// Mirrors `packages/sdk-ts/src/manifest/types.ts` (ManifestPrompt) and
// the route shapes in `packages/sdk-ts/src/handler/routes.ts`.

export type PromptType = 'file' | 'embedded'

export interface ManifestPromptListItem {
  id: string
  type: PromptType
  path: string
  hash: string
  /** First ~280 chars of the prompt body, trimmed. Used by the grid card preview. */
  preview: string
  // embedded only
  lineStart?: number
  lineEnd?: number
  charStart?: number
  charEnd?: number
  varName?: string
}

export interface PromptsListResponse {
  prompts: ManifestPromptListItem[]
  last_scan_at: string | null
}

export interface PromptDetailResponse {
  id: string
  type: PromptType
  path: string
  content: string
  varName?: string
}

export interface SubmitPrResult {
  ok: true
  pr: {
    prUrl: string
    prNumber: number
    branchName: string
  }
}

export interface GithubStatusResponse {
  connected: boolean
  repoOwner: string | null
  repoName: string | null
}

