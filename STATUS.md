# Status

> Snapshot of what's built and what's next. Updated as work proceeds.
> **Last updated:** 2026-05-05.

## Where we are

**Pre-v0 — skeleton complete.** Full directory structure, schemas, scaffolded SDKs, dashboard, examples, and docs are in place. Many implementations are stubbed against placeholders for infrastructure that isn't provisioned yet (control plane, GitHub App, judge service). The `Initial commit` lands the entire shape so contributors and the Artanis team can start filling things in.

For the human-side to-do list (npm publishing, GitHub App registration, Neon DB, Vercel, Clerk webhook, Polar, judge service, etc.), see [`gravel-cloud/docs/blockers.md`](https://github.com/artanis-ai/gravel-cloud/blob/main/docs/blockers.md) (Artanis-internal).

## What's done

### Repo structure
- pnpm workspace + Python project + dashboard + Mintlify docs + 3 example apps.
- Apache-2.0 license, README, CONTRIBUTING, ARCHITECTURE.

### TypeScript SDK (`@artanis/gravel`) — `packages/sdk-ts/`
- **Schema:** Drizzle for both Postgres + SQLite. All 13 `gravel_*` tables matching `data-model.md §1`.
- **DB layer:** dialect detection, lazy driver imports (`pg`, `better-sqlite3` as optional peers).
- **Bootstrap:** idempotent `CREATE TABLE IF NOT EXISTS` for both engines (substitutes for proper migrations until drizzle-kit setup).
- **Types & config:** `defineConfig`, `GravelUser`, `GravelConfig`, `resolveConfig` with auth-mode validation.
- **Auth:** HMAC-signed sessions for default-password mode + `getUser` callback gate, view-as cookie support, login rate-limit. Modes are mutually exclusive (per D-Q4 review-pass).
- **Handler factory:** fetch-style core + per-framework adapters (Next App Router, Next Pages Router, Express/generic Node).
- **Internal HTTP route table:** all dashboard endpoints from `api-surface.md §5` registered; bodies are stubs returning sensible 200/501 responses.
- **Manifest tooling:** `.artanis/manifest.json` types, IO, normalized hashing, fast scan, polite-blocking pre-commit hook installer (husky / pre-commit-framework / native git fallback).
- **Wizard:** framework + package manager + DB + auth detection across TS and Python repos; AST-friendly mount-route writers for Next.js (App + Pages Router) and FastAPI; copy-paste instructions for Express + Django + generic; config file generator; .env additions; password generator; bootstrap runner; OAuth handshake stubbed against a placeholder control-plane URL.
- **CLI:** `gravel init / migrate / manifest --check|--update|--list / scan --deep / doctor / help`.
- **Tracing:** `auto.ts` import-side-effect entry that detects installed LLM packages and emits a "scaffolding active" notice (provider patches arrive in v1). Async-context helpers (`withGravelMetadata`, `withTracingDisabled`, `gravelContext`).

### Python SDK (`artanis-gravel`) — `python/gravel/`
- **Schema:** SQLAlchemy mirror of the Drizzle schema. All 13 tables.
- **DB layer:** SQLAlchemy engine factory for Postgres + SQLite.
- **Bootstrap:** `metadata.create_all` idempotent.
- **Schema dump:** normalized text representation for the schema-drift CI.
- **Types & config:** `GravelConfig`, `GravelUser`, `resolve_config` with auth-mode validation.
- **Manifest tooling:** types, IO, hash (parity-tested algorithm with TS), fast scan, hook installer.
- **Wizard:** detect (FastAPI / Django / Flask / generic ASGI/WSGI), env writer, password gen, config file generator (Django auth pre-wired), mount router for FastAPI + instructions for Django/generic, bootstrap runner, doctor.
- **CLI:** `gravel init / migrate / manifest check|update|list / doctor` via click; entry as `python -m artanis_gravel`.
- **Integrations:** `fastapi.create_gravel_router`, `django.gravel_urls`, `asgi.GravelAsgiApp` + `gravel_wsgi_app`. All stubbed minimally — real route handlers ride on the dashboard's API client.
- **Tracing:** `auto.py` parallel to TS `auto.ts`.

### Dashboard React app (`packages/dashboard/`)
- Vite + React 19 + Tailwind + TanStack Query + Wouter routing.
- Layout with sidebar, top bar, role-aware nav (admin sees Settings).
- Empty-state component used across all routes.
- Same-origin API client (`/admin/ai/api/*`).
- Route stubs: Prompts, Traces, Datasets, Evals, Analysis, Settings, Login.
- Login screen for default-password mode.
- Tailwind preset matching the lander's cream/Fredoka palette.
- The TS handler's `htmlShell` currently serves a minimal placeholder; the bundled dashboard is wired to be served at the mount path once the build copies `dist/` into the SDK at release time.

### Examples (`examples/`)
- **`nextjs-app-router/`** — Next.js 15 App Router app with Gravel mounted at `/admin/ai`, Clerk-style placeholder, OpenAI call to demonstrate eventual tracing.
- **`fastapi/`** — FastAPI + uvicorn + Gravel router included.
- **`django/`** — README + integration snippet (no full project yet; v0 follow-up).

### Mintlify docs (`apps/docs/`)
- `mint.json` configured with primary brand colors.
- Pages: Introduction, Install, Quickstart, Architecture, Data residency, Manifest, The loop, Next.js / Express / FastAPI / Django integrations, Config / CLI / API / Auth / Tracing references.

### CI (`.github/workflows/`)
- `ci.yml`: lint + typecheck + build for TS, lint + tests for Python.
- `schema-drift.yml`: dumps both schemas, diffs them, fails on drift.

## What's stubbed (waits on infrastructure)

| Stub | Cross-references |
|---|---|
| Wizard browser OAuth handshake | `gravel-cloud/docs/blockers.md` §control-plane |
| `gravel.config.ts` written by wizard but `getUser` not exercised end-to-end | n/a — works once user wires their auth |
| Internal HTTP API: most routes return `{error: 'not-implemented'}` | full implementation lands alongside dashboard CRUD work |
| Tracing auto-patches: no provider patches yet | `decisions.md` D-Q22 — v1 priority |
| Dashboard SPA bundle copy step | `gravel-cloud/docs/blockers.md` §release |
| Drizzle-kit migrations | `gravel-cloud/docs/blockers.md` §drizzle-kit |
| GitHub App PR creation | `gravel-cloud/docs/blockers.md` §github-app |
| Judge / billing | v2 — `gravel-cloud/docs/blockers.md` §judge, §polar |
| Mallet analysis call | v3 |

## What's next

After infra blockers are knocked out:

1. Wire the dashboard SPA into the SDK (Vite build → static assets in `_dashboard/`; serve from the handler).
2. Implement the GitHub App PR creation flow against a real App registration.
3. Implement actual prompt CRUD endpoints (`PUT /api/prompts/:id`, `POST /api/prompts/submit`).
4. Land tracing patches for OpenAI + Anthropic (v1).
5. Per-framework integration tests (Next.js / Express / FastAPI / Django / generic ASGI).

## How to read this repo as a new contributor

1. [`README.md`](README.md) — what this is.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — public-safe overview.
3. The package you care about: `packages/sdk-ts/`, `python/gravel/`, `packages/dashboard/`, `apps/docs/`, or `examples/`.
4. For strategic / design context (PRD, roadmap, ADR log, full data-model spec): ask for access to `artanis-ai/gravel-cloud/docs/`.

## Repo locations

| Repo | Visibility | Purpose |
|---|---|---|
| `artanis-ai/gravel` (this) | Public, Apache-2.0 | The OSS lib. |
| `artanis-ai/gravel-cloud` | Private | Control plane, judge, internal product docs. |
| `artanis-ai/home-page` | Public | `artanis.ai` marketing + Mallet + Gravel preview lander. |
