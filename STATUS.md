# Status

> **Last updated:** 2026-05-06 (heads-down roadmap push, pass 5).

## Where we are

**v0 wedge backend is live.** Customers can wizard-install, sign in to a default-password dashboard, list manifest prompts, save edits as drafts. PR-submission via the dedicated `gravel[bot]` GitHub App is **TBD** — registration runbook at [`gravel-cloud/docs/runbook/github-app-setup.md`](../gravel-cloud/docs/runbook/github-app-setup.md); the OAuth-as-the-DE flow that previously gated this was reverted in `decisions.md` D-Q53 (2026-05-07 entry). The dashboard prompt editor UI is shipped; SPA bundling into the SDK package is shipped.

**v1 tracing landed on both SDKs.** OpenAI / Anthropic / Langchain auto-patches in TypeScript and Python; Vercel AI SDK on the TS side too. Streaming works without consuming the iterator the user passes through. Trace persistence honours `GRAVEL_TRACING_DISABLED=1` and per-config PII scrubbers.

**v2 (judge dispatcher + worker) shipped ahead of schedule.** Project ownership enforced; `judge_calls` audit row written on every call.

**v3 (Mallet analysis) plumbed through Clerk-org rate-limiting.** `/api/gravel/analyze` on the Mallet worker is bearer-gated; the control plane proxies with the customer's Clerk org id as the rate-limit bucket. Free-tier vs paid-tier is the only piece waiting on Polar pricing.

## Built so far

### `artanis-ai/gravel` (this repo, public)

- **TypeScript SDK** (`@artanis-ai/gravel`):
  - Schemas (Postgres + SQLite), DB connector, idempotent bootstrap.
  - Types/config with mutually-exclusive auth-mode validation.
  - HMAC sessions + view-as.
  - **Default-password auth wired** (login / logout / view-as routes — IP rate-limited, HMAC-signed sessions, HttpOnly+Secure cookies).
  - **Prompts backend** (`src/prompts/{drafts,submit,user-extra}.ts` + 6 wired routes):
    - `GET /api/prompts` + `GET /api/prompts/:id` (manifest-backed).
    - `PUT /api/prompts/:id` upserts a draft.
    - `GET /api/prompts/drafts` lists user's drafts.
    - `DELETE /api/prompts/:id/draft` discards.
    - `POST /api/prompts/submit` orchestrates: read drafts → group by file → fetch current content via GH API → apply surgical edits in descending char-start order → call `createPullRequest()` → clear drafts.
  - **GitHub OAuth wired through** (`/api/github/{status,connect,callback,repo}`): callback persists the access token in `gravel_users.extra`, repo selection via POST.
  - **Tracing auto-patches** for OpenAI / Anthropic / Langchain / Vercel AI SDK. Lazy provider import; missing SDKs no-op. Streaming via Symbol.asyncIterator tee.
  - Manifest tooling (fast scan + polite-blocking pre-commit hook installer).
  - Wizard: framework detection, AST-aware mount writers, config gen, .env writer, **live OAuth handshake against `gravel.artanis.ai`**, `--api-key/--project` non-interactive shortcut.
  - CLI (init / migrate / manifest / scan / doctor).
  - **Judge client** (`judgeCall()`) + **eval runner** (`runEval()` with bounded concurrency).
  - **Mallet `analyzePrompt()`**.
  - **Tests:** vitest 55 passed / 1 skipped.

- **Python SDK** (`artanis-gravel`):
  - Full SQLAlchemy parity with TS schema.
  - FastAPI / Django / generic ASGI/WSGI integrations.
  - Wizard parity with TS (live OAuth handshake, libcst-based router injection).
  - Judge client + eval runner + analyze client.
  - **Tracing auto-patches** for OpenAI / Anthropic / Langchain. contextvars for ALS-equivalent.
  - **Tests:** pytest 62 passed / 1 skipped.

- **Dashboard** (Vite + React 19 + Tailwind):
  - Routes built: Traces (list + detail + feedback), Datasets (list + create + detail with eval triggers), Evals (runs list + detail + breakdown modal + cancel), Analysis (Mallet panel).
  - Bundle: 85 KB gzipped (well under the 250 KB budget).
  - Prompts editor route: in flight (agent running at time of writing).
  - SPA bundling into the SDK package: pending (mechanical, ~1 hr).

- **GitHub OAuth + PR creation** — lifted from Mallet; `createPullRequest()` handles multi-file changes per spec/prompts.md §6.
- **Migrations** — drizzle-kit configs for Postgres + SQLite + `migrations:generate`; Alembic for Python.
- **Examples** — runnable Next.js App Router, FastAPI, Django README.
- **Mintlify docs** — 17 pages.
- **CI workflows** — `ci.yml`, `schema-drift.yml`, `publish-{npm,python}.yml`.

### `artanis-ai/gravel-cloud` (private)

- **`apps/control-plane/`** (Next.js 15 + Clerk + Drizzle on Vercel + Neon):
  - Live at `https://gravel.artanis.ai`. **Production Clerk instance** (shared with platform).
  - Auto-deploys on push to main (Vercel rootDirectory fixed).
  - DB migrations run via `.github/workflows/db-migrate.yml` on push (Neon `DATABASE_URL` is a repo secret).
  - `/api/health`.
  - `/api/judge` — Clerk-native API key auth, project ownership check, audit log.
  - `/api/analyze` — Clerk-native API key auth → forwards to Mallet's authed endpoint with `MALLET_FORWARD_TOKEN` + `X-Gravel-Org` header for per-org rate-limiting.
  - `/api/projects` (GET, POST) + `/api/projects/[id]` (GET, soft DELETE).
  - `/api/projects/[id]/keys` (GET list, POST mint) + `/api/projects/[id]/keys/[keyId]` (DELETE revoke).
  - `/api/cli/auth/{init,authorize,claim}` — real DB sessions (10 min TTL). `init` rate-limited (10/min/IP).
  - `/api/webhooks/clerk` — svix-verified, idempotent via `processed_webhooks` dedup.
  - `/api/webhooks/polar` — Standard Webhooks signature verification, persists `polar_subscriptions` + `polar_credit_purchases` rows. **Decrement / tier-update logic deferred per Yousef.**
  - `/cli/auth` wizard hand-off page, `/projects` dashboard, `/sign-in`, `/sign-up`, `/docs` (7 MDX pages).
  - Middleware: Clerk auth + CSRF Origin check on browser-mutating endpoints.
  - **Hardening headers**: full CSP, HSTS preload, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, X-Content-Type-Options.
  - Vitest suite covering authenticateRequest, svix webhook rejection, rate-limit, Polar webhook (17 cases).
- **`apps/judge/`** — Cloudflare Worker scoring service.
- **`apps/clerk-webhook-dev/`** — public stub for Clerk dev events.
- **`docs/`** — full PRD, roadmap, decisions (D-Q1–D-Q73), spec/*, refreshed blockers, audit, morning brief.

### `artanis-ai/home-page/mallet-worker` (this is in a separate repo)

- Existing `/api/public/analyze` (IP-rate-limited, used by the `mallet-prompt-review` agent skill) — untouched.
- New `/api/gravel/analyze` (bearer-gated with `GRAVEL_FORWARD_TOKEN`, rate-limited per `X-Gravel-Org` org id). 13 vitest cases.

## What's stubbed (intentionally)

| Stub | Why | Where |
|---|---|---|
| Dashboard prompt editor screen | In flight (agent running) | `packages/dashboard/src/routes/Prompts.tsx` |
| Dashboard SPA bundled into SDK | Pending — mechanical Vite-output integration | `packages/sdk-ts/src/handler/routes.ts` `htmlShell` |
| In-app notifications | Spec says v0 is browser localStorage only | dashboard |
| GitHub repo picker (list user's repos) | v1+ — for now the dashboard takes free-text owner/name | dashboard |
| SQLite parity for `prompts/drafts.ts` + `prompts/user-extra.ts` | Postgres-only for v0 | sdk-ts |

## Cloud verification (run anytime)

```bash
curl -s https://gravel.artanis.ai/api/health
curl -s https://gravel-judge.artanis-ai.workers.dev/health
# Mint a real prod-issued Clerk API key and call /api/judge or /api/analyze
# (See gravel-cloud/docs/morning-brief-2026-05-06.md for the curl recipe.)
```

## What's next

See `gravel-cloud/docs/roadmap.md` for the phased plan with status badges. Immediate items:

1. Land the dashboard prompt editor (in flight).
2. Bundle dashboard SPA into the SDK package.
3. Pair with Yousef on Polar pricing → wire credit decrement + tier updates.
4. First publish to npm / PyPI when content is meaningful.
