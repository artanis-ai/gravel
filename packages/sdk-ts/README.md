# @artanis-ai/gravel

The TypeScript SDK for [Gravel](https://gravel.artanis.ai).

**Status:** pre-v0. Not on npm yet.

```bash
# What this will look like once v0 ships:
curl -fsSL https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh | sh
gravel init
pnpm add @artanis-ai/gravel
```

The `gravel` CLI ships as a single Go binary from GitHub Releases (see [`install.sh`](https://github.com/artanis-ai/gravel/blob/main/install.sh)). This npm package is the SDK library only; it does not carry the CLI.

See [`/STATUS.md`](../../STATUS.md) for what's built and what's next.

## What's in this package

- The TS SDK (`@artanis-ai/gravel`).
- The bundled React dashboard (built from `packages/dashboard/` and copied here at release).
- Framework integrations (`@artanis-ai/gravel/next`, `/next-pages`, `/node`).

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
