# Status

> Snapshot of what's built and what's next. Updated as work proceeds.
> **Last updated:** 2026-05-06 (overnight build + post-audit refactor).

## Where we are

**Cloud is live and the SDKs talk to it.** The full v2/v3 backend (judge + Mallet analysis + Clerk-native API keys) shipped overnight, including a CSRF-hardened dashboard, real DB-backed wizard handshake, judge_calls audit logging, and CI-driven Drizzle migrations on push.

**The v0 wedge — DE edits prompt → PR appears — is still half-done.** The auth path, manifest read, and GitHub OAuth scaffolding are all in place; what's missing is the dashboard's prompt editor UI, the draft-branch accumulation logic, and the `POST /api/prompts/submit` PR-creation handler. Those need UX review before landing.

## Built so far

### `artanis-ai/gravel` (this repo, public)

- **TypeScript SDK** (`@artanis-ai/gravel`):
  - Schemas (Postgres + SQLite), DB connector, idempotent bootstrap.
  - Types/config with mutually-exclusive auth-mode validation.
  - HMAC sessions + view-as.
  - Fetch-style handler core + Next App/Pages/Express adapters.
  - **Default-password auth wired** (login/logout/view-as routes — IP rate-limited, HMAC-signed sessions, HttpOnly+Secure cookies).
  - **Manifest-backed `GET /api/prompts` + `GET /api/prompts/:id`** (slices embedded prompts by char range).
  - Manifest tooling (fast scan + polite-blocking pre-commit hook installer).
  - Wizard: framework detection, AST-aware mount writers, config gen, .env writer, **live OAuth handshake against `gravel.artanis.ai`**, `--api-key/--project` non-interactive shortcut.
  - CLI (init / migrate / manifest / scan / doctor).
  - **Judge client** (`judgeCall()`) + **eval runner** (`runEval()` with bounded concurrency) — verified end-to-end against the live judge.
  - **Mallet `analyzePrompt()`** — proxies through control plane.
  - Tracing context helpers (auto-patches still scaffolded).
- **Python SDK** (`artanis-gravel`):
  - Full SQLAlchemy parity with TS schema.
  - FastAPI / Django / generic ASGI/WSGI integrations.
  - Wizard: parity with TS (live OAuth handshake, libcst-based router injection, `--api-key/--project`).
  - Judge client + eval runner + analyze client.
- **Dashboard** — Vite + React 19 + Tailwind. Route stubs for Prompts, Traces, Datasets, Evals, Analysis, Settings, Login. **Bundling into the SDK still pending** (currently served as an HTML skeleton).
- **GitHub OAuth + PR creation** — lifted from Mallet; `/api/github/connect` and `/api/github/callback` wired.
- **Migrations** — drizzle-kit configs for Postgres + SQLite + `migrations:generate`; Alembic for Python.
- **Examples** — runnable Next.js App Router app, FastAPI app, Django README.
- **Mintlify docs** — 17 pages.
- **CI workflows** — `ci.yml`, `schema-drift.yml`, `publish-npm.yml`, `publish-python.yml`.
- **Tests:** vitest 37 passed / 1 skipped, pytest 32 passed / 2 skipped.

### `artanis-ai/gravel-cloud` (private)

- **`apps/control-plane/`** (Next.js 15 + Clerk + Drizzle on Vercel + Neon):
  - Live at `https://gravel.artanis.ai`.
  - `/api/health`.
  - `/api/judge` — Clerk-native API key auth, **project ownership check** (404s if project_id doesn't belong to the authed Clerk org), forwards to judge worker, **writes `judge_calls` audit row** on every call.
  - `/api/analyze` — Mallet proxy with the same auth.
  - `/api/projects` (GET, POST) + `/api/projects/[id]` (GET, soft DELETE).
  - `/api/projects/[id]/keys` (GET list, POST mint) + `/api/projects/[id]/keys/[keyId]` (DELETE revoke). Tracks Clerk-issued keys via `project_api_key_refs`.
  - `/api/cli/auth/{init,authorize,claim}` — real DB sessions (10 min TTL).
  - `/api/webhooks/clerk` — svix-verified, **idempotent via `processed_webhooks` dedup**.
  - **`/cli/auth`** wizard hand-off page (Clerk-authed, project picker, mint+claim).
  - **`/projects`** dashboard (list / create / mint key / soft-delete) with copy-to-clipboard `.env` snippet.
  - **`/sign-in`, `/sign-up`** Clerk catch-all routes.
  - **`/docs`** — 7 MDX pages (overview, install, auth, evals, judge, cli, api-keys).
  - Middleware: Clerk auth gating + **CSRF Origin check** on browser-mutating endpoints.
  - **CI**: `db-migrate.yml` runs Drizzle migrations against Neon on push to main; `db-check.yml` validates schema on PRs.
  - Vitest suite covering authenticateRequest + svix webhook rejection.
- **`apps/judge/`** — Cloudflare Worker scoring service. v0.1.0 scores against `accuracy / tone / completeness / safety` using `gpt-4.1-mini`. DISPATCHER_TOKEN auth.
- **`apps/clerk-webhook-dev/`** — public stub for Clerk dev events.
- **`docs/`** — `prd.md`, `roadmap.md`, `decisions.md` (D-Q1–D-Q73), `spec/*`, `blockers.md` (current), `audit-2026-05-06.md` (post-overnight self-review), `morning-brief-2026-05-06.md`.

## What's stubbed (intentionally)

| Stub | Why | Where |
|---|---|---|
| `PUT /api/prompts/:id` + `POST /api/prompts/submit` | Heart of v0; needs UX review (draft-branch accumulation + submit confirmation flow). | sdk-ts `handler/routes.ts` |
| GH callback token persistence | Needs schema slot in `gravel_users.extra` + auth context. | sdk-ts `handler/routes.ts` |
| Dashboard SPA bundled into the SDK | The Vite build output isn't included in the published package yet. Dashboard renders an HTML skeleton currently. | sdk-ts `handler/routes.ts` `htmlShell` |
| Tracing auto-patches (OpenAI / Anthropic / Langchain / Vercel AI SDK) | v1 work; trace context helpers exist but no module patches. | sdk-ts `auto.ts` |
| In-app notifications | v0 nice-to-have; trivial to scaffold once dashboard SPA wires up. | not started |
| Polar billing | Postponed until Yousef pairs through the integration. | not started |

## Cloud verification (run anytime)

```bash
curl -s https://gravel.artanis.ai/api/health
curl -s https://gravel-judge.artanis-ai.workers.dev/health
# Live judge call
KEY=ak_TBVF5BAETAHJW2QWECYJ4169YG6CGG4X
curl -sX POST https://gravel.artanis.ai/api/judge \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"project_id":"<proj_id>","type":"trace","input":{"prompt":"2+2?"},"output":"4","expected_correction":"4","prompt_context":null,"criteria":["correctness"]}'
```

## What's next

See `gravel-cloud/docs/roadmap.md` for the phased plan. The immediate next slice is the **prompt-PR flow** (v0 wedge):
1. Implement `PUT /api/prompts/:id` to accumulate edits in a draft branch in `.artanis/`.
2. Implement `POST /api/prompts/submit` to call Mallet's GH App and open a PR.
3. Bundle the Vite dashboard into the SDK package.
4. Wire the dashboard's prompt editor screen.

Tracing (v1) and live evals (v3) are sequenced after; all of v2 (judge dispatcher + judge worker) is already shipped.
