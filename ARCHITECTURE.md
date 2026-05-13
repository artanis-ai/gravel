# Architecture

> Public-safe overview of how Gravel is built.

## Two trust zones

Gravel splits cleanly into two zones. The control plane is **optional** — every default feature works offline against the data plane alone.

```
┌──────────────────────────────────────────────────┐    ┌──────────────────────────────────────────────────┐
│ DATA PLANE — your infrastructure                 │    │ CONTROL PLANE — Artanis (optional)               │
│                                                  │    │                                                  │
│ - Your app + Gravel SDK                          │    │ - gravel.artanis.ai                              │
│ - Your database: gravel_samples, gravel_feedback │    │ - gravel-judge.artanis-ai.workers.dev            │
│ - .gravel/manifest.json (in your repo)           │    │                                                  │
│ - Embedded React dashboard at /admin/ai          │    │ Touched only when you opt into:                  │
│                                                  │◄──►│   - paid eval judging (runEval → judge worker)   │
│ Holds: samples (one per LLM call),               │    │   - Mallet prompt analysis (analyzePrompt)       │
│        feedback (score + correction),            │    │   - GitHub App token mints for PR submission     │
│        prompts (text + manifest entries).        │    │                                                  │
│                                                  │    │ Disable entirely: don't call runEval /           │
│ Self-contained: every default feature            │    │ analyzePrompt, skip the GH App install. Set      │
│ works without ever touching the right box.       │    │ GRAVEL_TRACING_DISABLED=1 if you also want to    │
│                                                  │    │ suppress the npm/PyPI version-check ping.        │
└──────────────────────────────────────────────────┘    └──────────────────────────────────────────────────┘
```

The trust boundary is hard. Sample data, feedback, and prompts stay in your database. Only the input + stored output of rows being judged in a paid eval ever cross to Artanis, and only when your code (or your domain expert clicking "Run eval" in the dashboard, once that pillar ships) explicitly triggers it.

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
3. **Lowest-friction install.** `pnpm add @artanis-ai/gravel && pnpm gravel init` (or `uv add artanis-gravel && uv run gravel init`) is the only sequence a user ever has to run. SDK + CLI in one install; the wrapper lazy-fetches the matching Go binary. The wizard detects framework + package manager + DB + auth provider from the user's lockfiles, AST-edits the entry file to mount the dashboard, writes a `gravel.config.ts` / `gravel_config.py` with a `getUser` stub matched to the detected auth, and writes a random admin password into `.env.local`. No browser handshake, no test HTTP call to gravel.artanis.ai — the wizard runs fully offline.
4. **Framework agnostic.** Both Node (Next.js App + Pages, Express, Hono, Fastify, generic) and Python (FastAPI, Django, Flask, generic ASGI / WSGI) first-class from day one.
5. **No phone-home by default.** The SDK only makes outbound HTTP when the host opts in:
   - Judge calls (only when the host calls `runEval` / `run_eval`).
   - Mallet `analyzePrompt` (only when the host calls it).
   - GitHub App installation-token mints to `gravel.artanis.ai/api/cli/github/installation-token` (only when the dashboard's "Submit changes" button fires).
   - npm / PyPI version-check ping for the dashboard's "update available" banner (admin-only, throttled, suppress with `GRAVEL_VERSION_CHECK_DISABLED=1`).
   The auto-tracing patches DO NOT phone home — captured samples land in the host's own database via the SDK's persist path.

## Schema parity

The TS and Python schemas must stay in lockstep. CI runs both migration sets against an empty Postgres + SQLite, dumps the schema, and diffs them. Drift fails CI. See `.github/workflows/schema-drift.yml`.

## Where to start

- Code: pick a package directory and read its README.
- Run the wizard against a throwaway repo; it self-documents.
- Issues: open one if anything's unclear.
