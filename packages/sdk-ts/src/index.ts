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
