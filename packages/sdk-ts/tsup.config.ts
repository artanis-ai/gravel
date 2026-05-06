import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    auto: 'src/auto.ts',
    next: 'src/integrations/next.ts',
    'next-pages': 'src/integrations/next-pages.ts',
    node: 'src/integrations/node.ts',
    cli: 'src/cli/index.ts',
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
})
