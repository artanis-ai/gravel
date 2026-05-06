/**
 * Public API surface for @artanis-ai/gravel.
 *
 * Stable across minor versions. Spec: gravel-cloud/docs/spec/api-surface.md
 */

export { defineConfig, resolveConfig } from './types.js'
export type {
  GravelConfig,
  GravelUser,
  GravelRole,
  GravelRequest,
  GravelDatabaseConfig,
  GravelAuthConfig,
  GravelEvalsConfig,
  RunPipelineFn,
  ResolvedGravelConfig,
} from './types.js'

export { createGravelHandler } from './handler/index.js'

// Tracing context helpers
export { withGravelMetadata, withTracingDisabled, gravelContext } from './tracing/context.js'
export { setGravelTracingConfig } from './tracing/persist.js'

// Judge / evals
export { judgeCall, JudgeError } from './judge/client.js'
export type {
  Verdict,
  VerdictBreakdownEntry,
  JudgeType,
  JudgeCallInput,
  JudgeCallOptions,
  JudgeApiResponse,
} from './judge/client.js'
export { runEval } from './evals/runner.js'
export type { EvalRow, EvalResult, RunEvalOptions, RunEvalReturn } from './evals/runner.js'

// Analyze (Mallet)
export { analyzePrompt, AnalyzeError } from './analyze/client.js'
export type { AnalyzeIssue, AnalyzeUsage, AnalyzeResult } from './analyze/client.js'
