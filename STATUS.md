# Status

> Snapshot of what's built and what's next. Updated as work proceeds.
> **Last updated:** 2026-05-05 (build session 2).

## Where we are

**Pre-v0 — skeleton + first wiring complete.** The full code structure is in place across both repos. Control plane + judge service are scaffolded; the publish pipeline is configured; the GitHub PR creation flow is lifted from Mallet. What's left for v0 is mostly **provisioning** (DNS, Neon DB, Clerk webhook setup) — all listed in [`gravel-cloud/docs/blockers.md`](https://github.com/artanis-ai/gravel-cloud/blob/main/docs/blockers.md).

## Built so far

### `artanis-ai/gravel` (this repo, public)

- **Repo + monorepo skeleton.** pnpm workspace + Python project + dashboard + Mintlify docs + 3 example apps. Apache 2.0.
- **TypeScript SDK** (`@artanis-ai/gravel`) — full skeleton: schemas (Postgres + SQLite), DB connector, idempotent bootstrap, types/config with mutually-exclusive auth-mode validation, HMAC sessions + view-as, fetch-style handler core + Next App/Pages/Express adapters, full internal route table with stubs, manifest tooling (fast scan + polite-blocking pre-commit hook installer), wizard (framework detection + AST-aware mount writers + config gen + .env writer), CLI (init / migrate / manifest / scan / doctor), tracing scaffolding.
- **Python SDK** (`artanis-gravel`) — full SQLAlchemy parity. FastAPI / Django / generic ASGI/WSGI integrations.
- **Dashboard** — Vite + React 19 + Tailwind + TanStack Query + Wouter. Same-origin API client. Route stubs for Prompts, Traces, Datasets, Evals, Analysis, Settings, Login.
- **GitHub OAuth + PR creation** — lifted from Mallet's `routes/oauth.ts` + `routes/create-pr.ts`. Lib's `/api/github/connect` returns redirect URL; `/api/github/callback` verifies the JWT signed by the control plane; `createPullRequest()` does the `/git/refs` + `/contents` + `/pulls` dance with the user's gh access token. Per `decisions.md` D-Q53 build-session correction (gravel-bot identity dropped; PR by DE's GitHub user).
- **Migrations** — drizzle-kit configs for Postgres + SQLite + `migrations:generate` script; Alembic init + env.py for Python. Falls back to idempotent `bootstrap.ts` when no revisions exist (early v0).
- **Examples** — runnable Next.js App Router app, FastAPI app, Django README + integration snippet.
- **Mintlify docs** — 17 pages covering install, quickstart, four concept pages, four integration guides, five reference pages.
- **CI workflows:**
  - `ci.yml` — lint + typecheck + build for TS, lint + tests for Python.
  - `schema-drift.yml` — dumps both schemas, diffs them, fails on drift.
  - `publish-npm.yml` — OIDC trusted publishing on tag, **needs npm.com registration** (see blockers).
  - `publish-python.yml` — OIDC trusted publishing on tag, **needs pypi.org registration** (see blockers).

### `artanis-ai/gravel-cloud` (private)

- **`apps/control-plane/`** — Next.js 15 + Clerk + Drizzle scaffold. Routes:
  - `/`, `/projects`, `/cli/auth` — authed pages.
  - `/api/health`.
  - `/api/cli/auth/init` + `/api/cli/auth/claim` — wizard OAuth handshake.
  - `/api/cli/github/start` + `/api/github/callback` — GitHub OAuth proxy (matches Mallet's pattern; uses `GITHUB_CLIENT_SECRET`).
  - `/api/judge` — judge dispatcher (auth + credit-decrement + forward to judge worker).
  - `/api/webhooks/clerk` — Clerk events.
  - `middleware.ts` — Clerk auth gating.
  - `.env.example` listing the env vars Yousef needs to populate in Vercel.
- **`apps/judge/`** — Cloudflare Worker scoring service. v0.1.0 prompt scores against `accuracy / tone / completeness / safety` using `gpt-4.1-mini` with `temperature: 0`, `max_completion_tokens: 800`. Authenticated via `DISPATCHER_TOKEN` shared with the control plane.
- **`docs/dns.md`** — copy-paste-ready DNS records for Yousef.
- **`docs/blockers.md`** — refreshed list of remaining provisioning steps (most are 5-min items now).
- **`docs/decisions.md`** — D-Q53 (GitHub) and D-Q58 (npm scope) updated with build-session corrections.

## What's stubbed

| Stub | Why | Where |
|---|---|---|
| Wizard browser OAuth handshake | Control-plane DB not provisioned | gravel-cloud control-plane (`/api/cli/auth/*`) |
| Token persistence after `/api/github/callback` | Schema slot for gh_token in `gravel_users.extra` | sdk-ts `handler/routes.ts` |
| Internal HTTP API: most CRUD endpoints | Lands alongside dashboard wiring | sdk-ts `handler/routes.ts` |
| Tracing auto-patches | v1 priority | sdk-ts `auto.ts` |
| Dashboard SPA bundle copy step | Lands when first publish happens | release pipeline |
| Drizzle-kit generated migration files | Need a DATABASE_URL to introspect | migrations setup is done; SQL files generated on first run |
| Judge dispatcher (auth + DB calls) | Control plane DB + judge URL pending | gravel-cloud `/api/judge` |
| Polar | v2+ | gravel-cloud (deferred) |

## What's next

After Yousef knocks out the items in `gravel-cloud/docs/blockers.md`:

1. Wire the dashboard SPA's Vite output into both SDK packages at release time.
2. Implement actual prompt CRUD in `handler/routes.ts` (`PUT /api/prompts/:id`, `POST /api/prompts/submit`).
3. Implement gh-token persistence in the lib's auth layer.
4. Land tracing patches for OpenAI + Anthropic (v1).
5. Per-framework integration tests (Next.js / Express / FastAPI / Django).
6. Run `drizzle-kit generate` + `alembic revision --autogenerate` against an empty Postgres locally; commit the generated migration files.

## Repo locations

| Repo | Visibility | Purpose |
|---|---|---|
| `artanis-ai/gravel` (this) | Public, Apache-2.0 | OSS lib + dashboard + docs + examples. |
| `artanis-ai/gravel-cloud` | Private | Control plane, judge, judge prompts, internal product docs. |
| `artanis-ai/home-page` | Public | `artanis.ai` marketing + Mallet + Gravel preview lander at `/gravel`. |
