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
  splitting: false,
  sourcemap: true,
  target: 'node20',
})
