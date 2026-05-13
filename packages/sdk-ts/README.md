# @artanis-ai/gravel

The TypeScript SDK for [Gravel](https://gravel.artanis.ai).

**Status:** v0.5.x, live on npm.

```bash
npx @artanis-ai/gravel init
# or pnpm dlx / yarn dlx / bunx — anything that resolves the bin script
```

This package ships both the runtime SDK library AND a thin `bin/gravel.js` wrapper that lazy-downloads the matching Go binary from signed GitHub Release assets on first invocation. `npx @artanis-ai/gravel init` runs the wizard; the wizard auto-adds `@artanis-ai/gravel` to your `package.json` deps so the generated `gravel.config.ts` resolves at runtime. The binary is NOT bundled in the npm tarball; the wrapper is ~150 lines of source-visible JS. See [`cli/DESIGN.md`](https://github.com/artanis-ai/gravel/blob/main/cli/DESIGN.md) for the rationale.

For users who don't want Node in their CLI install path (Docker, CI, polyglot repos), the same binary is installable via [`install.sh`](https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh) directly.

See [`/STATUS.md`](../../STATUS.md) for what's built and what's next.

## What's in this package

- The TS SDK (`@artanis-ai/gravel`).
- The bundled React dashboard (built from `packages/dashboard/` and copied here at release).
- Framework integrations: `@artanis-ai/gravel/next` (App Router), `/next-pages` (Pages Router), `/fastify` (typed plugin), and `/node` — the generic Node bridge that Express, Hono, and any other `(req, res)` framework uses via `gravelHandler({ config })`.
- The CLI wrapper at `bin/gravel.js`. Read it before you trust it; under 150 lines of straightforward JS.

## Layout

```
src/
├── index.ts                  # public API exports (defineConfig, types)
├── auto.ts                   # the import-side-effect tracing entry point
├── types.ts                  # GravelUser, GravelConfig, etc.
├── schema/                   # Drizzle schema for gravel_* tables (data plane)
├── db/                       # db connector (Postgres + SQLite via Drizzle)
├── auth/                     # default password mode + getUser delegation
├── handler/                  # createGravelHandler core
├── integrations/             # framework-specific adapters
├── manifest/                 # .gravel/manifest.json read/write/scan + hook
├── tracing/                  # auto-patches for OpenAI/Anthropic/etc.
└── cli/                      # init, migrate, manifest, scan
```
