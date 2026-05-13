# Status

> **Last updated:** 2026-05-13 (v0.5.10 shipped; audit-driven fixes through v0.5.7–v0.5.11).

## Where we are

**Wedge backend is live and on PyPI + npm.** Customers can wizard-install on TS or Python hosts, sign in to a default-password dashboard (or auto-admin on loopback), list and edit manifest prompts (file-type or embedded with char-offset slicing), submit drafts as a single GitHub PR via the `gravel[bot]` GitHub App with the manifest atomically rewritten to keep subsequent prompts' offsets valid, view live traces, and leave feedback.

**Cross-stack parity is real.** Five integrations — FastAPI, ASGI, WSGI, Django, Flask — all delegate to one shared dispatcher (`python/gravel/src/artanis_gravel/_handler.py`) and return byte-equal responses for the same request. The TS handler is the second canon; CI cross-references both. Tracing auto-patches cover OpenAI / Anthropic / LangChain on Python (Vercel AI + generic `fetch` on TS as well).

**Cloud is live.** Control plane at `https://gravel.artanis.ai` (Next.js 15 + Clerk + Drizzle on Vercel + Neon, prod Clerk instance). Routes: `/api/health`, `/api/judge`, `/api/analyze`, `/api/projects`, `/api/cli/auth/*`, `/api/cli/github/install/start`, `/api/cli/github/installation-token`, `/api/webhooks/clerk`, `/api/webhooks/polar`.

**Judge + eval runner shipped** with project ownership enforcement and audit logging. **Mallet `analyzePrompt()` shipped** with Clerk-org rate-limiting through the CP proxy.

## Recent release activity (May 2026)

- **v0.5.7** — `GET /api/prompts/{id}` added to the Python SDK; PromptDetail page worked for the first time on Python hosts.
- **v0.5.8** — Real PyPI lookup in `/api/version`; UpdateBanner stopped reporting `hasUpdate: false` unconditionally. `CURRENT_VERSION = "0.1.0"` hardcoded value retired in favour of `importlib.metadata`.
- **v0.5.9** — Major Python SDK rewire: every route now flows through `_handler.py`. Killed `asgi.py` + `django.py` placeholders; added `/api/migrations/status`, `POST /api/prompts/submit`, `/api/github/install` + `/callback`, `POST /api/auth/view-as`; fixed form-encoded login redirect; added per-IP login rate-limiting; `/_assets/<file>` content-type map; `/api/prompts` honours `GRAVEL_REPO_ROOT` via the typed `manifest/io` helpers.
- **v0.5.10** — Heavy cross-stack journey coverage. New `tests/test_embedded_journey.py` pins byte-exact char-offset slicing across FastAPI/ASGI/WSGI/Django/Flask and PR + manifest rewrite invariants for adding/removing lines, multi-prompt edits in one file, hash-update semantics.
- **v0.5.11** — Closes the residual audit findings: TS auth gates on `/api/prompts`, `/api/samples`, `/api/github/status` to match Python (information disclosure fix). Unit tests for `_github_api.py` (24) and `samples_query.py` (50). Docs sweep removing stale "pre-v0 / stubbed / coming soon" claims across `apps/docs/*.mdx`, `packages/dashboard/README.md`, `packages/sdk-ts/migrations/README.md`, and this file. Bare-`except` hygiene in `auth.py` / `_github_api.py` / `judge/client.py`. Vercel AI + generic-fetch tracing ported to Python.

## What ships in `artanis-ai/gravel` today

### TypeScript SDK (`@artanis-ai/gravel`)
- Schemas (Postgres + SQLite), DB connector, idempotent bootstrap.
- HMAC sessions, view-as, per-IP login rate-limiting.
- Dashboard routes: auth (login/logout/me/view-as), version + update banner, migrations status, samples (list / detail / feedback), prompts (list / detail / submit), GitHub status + install start + callback, bundled SPA + assets.
- Tracing auto-patches: OpenAI, Anthropic, LangChain, Vercel AI, generic fetch. Lazy import; missing SDKs no-op. Streaming via `Symbol.asyncIterator` tee.
- Manifest tooling (fast scan + pre-commit hook installer).
- Wizard via the Go CLI: framework detection, AST-aware mount writers, config gen, `.env` writer, idempotent re-runs, deep scan.
- Judge client, eval runner with bounded concurrency, Mallet `analyzePrompt`.
- **Tests:** vitest, 170 passing.

### Python SDK (`artanis-gravel`)
- Full SQLAlchemy parity with TS schema.
- Same dashboard routes via the shared `_handler.py` dispatcher; FastAPI, ASGI, WSGI, Django, Flask integrations all adapters around it.
- Tracing auto-patches: OpenAI, Anthropic, LangChain (Vercel AI + fetch in v0.5.11).
- Wizard installs via the Go CLI binary (same as TS); Flask wizard auto-adds the `[flask]` extra for the a2wsgi bridge.
- Judge client, eval runner, analyze client.
- **Tests:** pytest, 250 passing + 1 skipped.

### Dashboard (Vite + React 19 + Tailwind)
- Routes: Login, Samples (list + detail + feedback), Datasets, Evals, Analysis, Prompts (list + detail editor with embedded slice editing + draft autosave to localStorage + submit modal).
- Components: PendingMigrationsBanner, UpdateBanner, CopyableCode.
- Bundle: ~85 KB gzipped.
- Bundled into both SDKs at release time (`tools/sync-dashboard-dist.sh` for Python; per-SDK build for TS).

### Go CLI / wizard
- Framework detection across 9 stacks. Two-phase entry search; column-zero-only AST-style mount writers per language.
- Heavy coverage in `cli/internal/wizard/*_test.go`.
- Manual prompt picker with `$EDITOR` integration for humans, line-number entry for agents; tab-completion on path input.

### Examples
- Next.js (App Router + Pages), Express, Hono, Fastify, FastAPI, Django, Flask.

### CI
- `ci.yml` (TS + Python with all extras including `flask`), `schema-drift.yml` (TS vs Python schema), `publish-{npm,python}.yml` (PyPI + npm publish on tag), `version-sync.yml` (lockstep enforcement).

## `artanis-ai/gravel-cloud` (private)

- Control plane on `gravel.artanis.ai`. Auto-deploys on push to main.
- Routes listed above.
- Hardening headers (CSP, HSTS preload, X-Frame-Options DENY, etc.).
- Vitest suite covering authenticateRequest, svix webhook rejection, rate-limit, Polar webhook.
- Judge service runs as a Cloudflare Worker (`apps/judge/`).

## Cloud verification (run anytime)

```bash
curl -s https://gravel.artanis.ai/api/health
curl -s https://gravel-judge.artanis-ai.workers.dev/health
```

For an authed call against `/api/judge` or `/api/analyze`, see `gravel-cloud/docs/morning-brief-*.md` for the curl recipe.

## What's next

See `gravel-cloud/docs/roadmap.md` for the phased plan. Immediate items:

1. Datasets pillar (create / detail / row editing).
2. Evals pillar (judge runs + breakdowns triggered from the dashboard).
3. Refactor the 673-line TS `routes.ts` into per-domain modules to match the Python `_handler.py` shape.
4. Increase dashboard test coverage to >50% (currently ~21%) with at least one E2E flow.
