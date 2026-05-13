import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    auto: 'src/auto.ts',
    define: 'src/define.ts',
    next: 'src/integrations/next.ts',
    'next-pages': 'src/integrations/next-pages.ts',
    node: 'src/integrations/node.ts',
    fastify: 'src/integrations/fastify.ts',
    // The CLI is no longer a TS module. `gravel` ships as a Go binary
    // installed via install.sh; see /cli/DESIGN.md.
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // Splitting must be ON: the auto-patch entry (./auto) and the main
  // entry both import ./tracing/persist.js, which holds module-scoped
  // state (the resolved tracing config + cached DB). Without splitting,
  // tsup emits two independent copies — `setGravelTracingConfig` only
  // mutates one of them and the other never sees a config.
  splitting: true,
  sourcemap: true,
  target: 'node20',
  // Auto-shims `import.meta.url` / `__dirname` so the same source code
  // works in both the ESM and CJS bundles. Without this, a literal
  // `import.meta` in a `.cjs` file is a SyntaxError at parse time
  // (which then crashes any host that webpack-externalises us via
  // `require('@artanis-ai/gravel/...')` from a Pages Router or App
  // Router build that happens to resolve our CJS entry).
  shims: true,
})
