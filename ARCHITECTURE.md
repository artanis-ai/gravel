# Architecture

> Public-safe overview of how Gravel is built. The full internal spec is in the private `artanis-ai/gravel-cloud` repo.

## Two trust zones

Gravel splits cleanly into two zones:

```
┌──────────────────────────────────────────┐    ┌──────────────────────────┐
│ DATA PLANE — your infrastructure         │    │ CONTROL PLANE — Artanis  │
│                                          │    │                          │
│ Your app + Gravel SDK                    │◄──►│ gravel.artanis.ai    │
│ Your database (gravel_* tables)          │    │ gravel-judge.artanis-ai.workers.dev  │
│ Embedded React dashboard at /admin/ai    │    │                          │
│                                          │    │ - project mgmt           │
│ Holds: traces, prompts, feedback,        │    │ - judge dispatch         │
│        datasets, eval runs               │    │ - billing                │
└──────────────────────────────────────────┘    └──────────────────────────┘
```

The trust boundary is hard. Trace data and prompts stay in your DB. Only rows being judged in a paid eval ever cross to Artanis.

## Components in this repo

### `@artanis-ai/gravel` (TypeScript SDK)

Source: `packages/sdk-ts/`. Published to npm.

- Auto-patches OpenAI / Anthropic / Langchain / Vercel AI SDK on import.
- Mounts the dashboard route (Next.js, Express, generic Node).
- Manages `gravel_*` tables in the user's Postgres or SQLite via Drizzle.
- Bundles the React dashboard as static assets.
- Ships a thin `bin/gravel.js` wrapper (~100 lines) that lazy-downloads the matching Go binary from the GitHub Release on first `pnpm gravel <cmd>` invocation. No bundled binary in the npm tarball.

### `artanis-gravel` (Python SDK)

Source: `python/gravel/`. Published to PyPI.

Mirror of the TS SDK. Uses SQLAlchemy + Alembic. First-class FastAPI + Django; generic ASGI/WSGI fallback. Same wrapper model: SDK library + `artanis_gravel._cli` shim that lazy-downloads the binary; one `uv add artanis-gravel` gives the user both. See [`cli/DESIGN.md`](cli/DESIGN.md) for the architecture rationale.

### Dashboard (React)

Source: `packages/dashboard/`. Vite-built; ships as static assets bundled inside both SDKs (not CDN-fetched).

## Cross-cutting principles

1. **Data residency.** Prompts and traces stay in the user's database. Only rows being actively judged are POSTed to Artanis.
2. **Git is the prompt store.** Prompts live where they live in the user's repo (files or embedded strings). Edits become PRs. No hot-reload, no Gravel-served prompt CDN.
3. **Lowest-friction install.** `pnpm add @artanis-ai/gravel && pnpm gravel init` (or `uv add artanis-gravel && uv run gravel init`) is the only sequence a user ever has to run. SDK + CLI in one install; the wrapper lazy-fetches the matching Go binary. Sentry-style: framework detection, browser OAuth, AST edits, test trace before exit.
4. **Framework agnostic.** Both Node (Next.js, Express, generic) and Python (FastAPI, Django, generic ASGI/WSGI) first-class from day one.
5. **No phone-home.** The library makes no outbound HTTP except: wizard OAuth (once at install), test trace (once at install), judge calls (per paid eval), Mallet analysis (per analysis), credit balance refresh.

## Schema parity

The TS and Python schemas must stay in lockstep. CI runs both migration sets against an empty Postgres + SQLite, dumps the schema, and diffs them. Drift fails CI. See `.github/workflows/schema-drift.yml`.

## Where to start

- Code: pick a package directory and read its README.
- Run the wizard against a throwaway repo; it self-documents.
- Issues: open one if anything's unclear.
