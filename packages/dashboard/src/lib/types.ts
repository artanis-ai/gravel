/**
 * Shared TypeScript types for dashboard payloads.
 *
 * Mirrors the backend route shapes defined in
 * `packages/sdk-ts/src/handler/routes.ts` and the schema in
 * `gravel-cloud/docs/spec/data-model.md`.
 */

export type TraceStatus = 'running' | 'completed' | 'errored'

export interface TraceListItem {
  id: string
  name: string
  model: string | null
  environment: string | null
  status: TraceStatus
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  feedback_count: number
  feedback_score: 'positive' | 'negative' | 'mixed' | null
}

export interface TracesResponse {
  traces: TraceListItem[]
  total: number
  page: number
  page_size: number
}

export interface Observation {
  id: string
  trace_id: string
  type: 'input' | 'output' | 'state'
  name?: string | null
  key?: string | null
  data: unknown
  timestamp: string
  started_at?: string | null
}

export interface FeedbackItem {
  id: string
  trace_id: string | null
  observation_id: string | null
  comment: string | null
  correction: string | null
  score: 'positive' | 'negative' | 'neutral' | null
  reporter_user_id: string | null
  created_at: string
}

export interface TraceDetailResponse {
  trace: TraceListItem & { commit_sha?: string | null; metadata?: Record<string, unknown> }
  observations: Observation[]
  feedback: FeedbackItem[]
}

export interface DatasetSummary {
  id: string
  name: string
  description: string | null
  trace_count: number
  updated_at: string
  created_at: string
}

export interface DatasetsResponse {
  datasets: DatasetSummary[]
  runPipelineConfigured: boolean
}

export interface DatasetTrace {
  dataset_trace_id: string
  trace: TraceListItem
}

export interface DatasetDetailResponse {
  dataset: DatasetSummary
  traces: DatasetTrace[]
  runPipelineConfigured: boolean
}

export type EvalRunStatus = 'queued' | 'pending' | 'running' | 'completed' | 'cancelled' | 'errored'
export type EvalRunType = 'trace' | 'live'

export interface EvalRunSummary {
  id: string
  dataset_id: string
  dataset_name: string
  type: EvalRunType
  status: EvalRunStatus
  total_rows: number
  completed_rows: number
  summary: { passed: number; failed: number } | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface EvalRunsResponse {
  runs: EvalRunSummary[]
}

export interface EvalResultRow {
  id: string
  trace_id: string | null
  input_snippet: string | null
  expected: string | null
  output: string | null
  live_output: unknown | null
  verdict: {
    score: number
    passed: boolean
    reasoning: string
    breakdown: Record<string, number>
  }
  created_at: string
}

export interface EvalRunDetailResponse {
  run: EvalRunSummary
  results: EvalResultRow[]
}

export interface MalletIssue {
  type: 'contradiction' | 'ambiguity' | 'best-practice' | string
  severity: 'error' | 'warning' | 'info' | string
  range: [number, number]
  message: string
}

export interface AnalysisResponse {
  issues: MalletIssue[]
  rate_limit?: {
    limit: number
    remaining: number
    reset_at: string
  }
}

// ---------- Prompts ----------
//
// Mirrors `packages/sdk-ts/src/manifest/types.ts` (ManifestPrompt) and the
// route shapes in `packages/sdk-ts/src/handler/routes.ts` (`/api/prompts*`,
// `/api/github/*`).

export type PromptType = 'file' | 'embedded'

export interface ManifestPromptListItem {
  id: string
  type: PromptType
  path: string
  hash: string
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

export interface DraftRow {
  id: string
  promptId: string
  draftBranch: string
  newText: string
  editorUserId: string | null
  createdAt: string
  updatedAt: string
}

export interface DraftsResponse {
  draftBranch: string
  drafts: DraftRow[]
}

export interface PutDraftResponse {
  draft: DraftRow
  draftBranch: string
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
  connectedAt: string | null
}
