# Status

> **Last updated:** 2026-05-13 (v0.5.15 shipped; audit-driven fixes through v0.5.7–v0.5.15).

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
- **v0.5.11** — Closes the residual audit findings: TS auth gates on `/api/prompts`, `/api/samples`, `/api/github/status` to match Python (information disclosure fix). Unit tests for `_github_api.py` (24) and `samples_query.py` (50). Bare-`except` hygiene in `auth.py` / `_github_api.py` / `judge/client.py`. Session TTL constant decoupled from the magic-number cookie Max-Age.
- **v0.5.12** — Generic-fetch tracing port to Python (httpx sync + async, requests, aiohttp, stdlib urllib; 41 tests against an in-process `http.server` thread). TS `routes.ts` split into per-domain files (`auth.ts`, `version.ts`, `migrations.ts`, `prompts.ts`, `github.ts`, `samples.ts`, `shell.ts`, `assets.ts`) to match the Python `_handler.py` shape; cookies + shell helpers extracted. New Playwright E2E suite for the dashboard (15 tests covering auth + samples + prompts + github flows), wired into CI as a dedicated `dashboard-e2e` job.
- **v0.5.13** — Wizard detects a dev server already listening on the framework default port and warns "restart your server" so newly-written mount code is actually picked up (real customer 404 closed). Dashboard component test coverage roughly doubled with new PayloadShape (12), CopyableCode (6), and Login (8) suites. CI caches Playwright browser binaries by version, saving ~30s per run. `gravel-test-fixtures` gains a `manifest:deep-scan` journey that runs `gravel scan --deep --yes` and asserts the manifest gains embedded entries in declared `deepScanFiles` paths.
- **v0.5.14** — Deep-scan rewrite. (1) Killed the dead OpenAI file-by-file scan path (`packages/sdk-ts/src/manifest/deep-scan.ts`) — only its test imported it, never wired into the wizard. One deep-scan now: the agent-delegated one. (2) Agent contract switched from line-only + `snippet` to `startsWith` / `endsWith` anchors — short substrings of the prompt content as they literally appear on `lineStart` / `lineEnd`. The SDK resolves the anchors to precise offsets itself (str.find on the bounded line); no more "the slice includes the surrounding `const X = "..."` syntax." (3) Manifest `charStart` / `charEnd` are now Unicode code points everywhere. Previously: Go wrote UTF-8 byte offsets, TS wrote UTF-16 code units, Python sliced as code points — any non-ASCII content (em-dash, smart quote, accented letter, emoji) desynced the three counts and the handler cut the wrong characters. New helpers in `manifest/offsets.{go,ts}` (`SliceByCodePoints`, `CodePointLen`, `LineContentCodePoints`); all readers/writers go through them. Round-trip multi-byte tests added in Go, TS, Python.
- **v0.5.15** — Dashboard UX bug fixes. (a) Modal backdrop now covers the full viewport — switched to `createPortal(document.body)` so `fixed inset-0` is viewport-anchored regardless of any transform / backdrop-blur ancestor. The earlier "no portal because of host CSS scope" comment was wrong; Tailwind classes work fine through portals. (b) CLI commands shown in the dashboard (`gravel migrate`, `gravel manifest --update`, `gravel init --traces`) now use the SDK-runtime-aware form: `npx @artanis-ai/gravel ...` for TS hosts, `uvx artanis-gravel ...` for Python hosts. Earlier copy assumed a globally-installed `gravel` binary, which the wizard doesn't set up for users who invoked the wizard via `uvx` / `npx`. New `window.__GRAVEL_RUNTIME__` global injected by the shell rewriter; new `gravelCommand()` helper in `packages/dashboard/src/lib/runtime.ts`. (c) Dropped the fictional `gravel github connect` command from the GithubNotConnectedDialog — there's no such subcommand; the in-dashboard "Install GitHub App" button is the real install flow and the dialog already explains it.

## What ships in `artanis-ai/gravel` today

### TypeScript SDK (`@artanis-ai/gravel`)
- Schemas (Postgres + SQLite), DB connector, idempotent bootstrap.
- HMAC sessions, view-as, per-IP login rate-limiting.
- Dashboard routes (per-domain modules under `src/handler/routes/`): auth (login/logout/me/view-as), version + update banner, migrations status, samples (list / detail / feedback), prompts (list / detail / submit), GitHub status + install start + callback, bundled SPA + assets.
- Tracing auto-patches: OpenAI, Anthropic, LangChain, Vercel AI, generic `globalThis.fetch`. Lazy import; missing SDKs no-op. Streaming via `Symbol.asyncIterator` tee.
- Manifest tooling (fast scan + pre-commit hook installer).
- Wizard via the Go CLI: framework detection, AST-aware mount writers, config gen, `.env` writer, idempotent re-runs, deep scan, running-server detection + restart warning.
- Judge client, eval runner with bounded concurrency, Mallet `analyzePrompt`.
- **Tests:** vitest, 170 passing + 1 skipped.

### Python SDK (`artanis-gravel`)
- Full SQLAlchemy parity with TS schema.
- Same dashboard routes via the shared `_handler.py` dispatcher; FastAPI, raw ASGI, raw WSGI, Django, Flask integrations are all adapters around it.
- Tracing auto-patches: OpenAI, Anthropic, LangChain. Generic-fetch patches for httpx (sync + async), requests, aiohttp, and stdlib urllib (v0.5.12+; lazy per-transport, missing library no-ops).
- Wizard installs via the Go CLI binary (same as TS); Flask wizard auto-adds the `[flask]` extra for the a2wsgi bridge.
- Judge client, eval runner, analyze client.
- **Tests:** pytest, 291 passing + 1 skipped.

### Dashboard (Vite + React 19 + Tailwind)
- Routes shipped: Login, Samples (list + detail + feedback), Prompts (list + detail editor with embedded slice editing + draft autosave to localStorage + submit modal).
- Routes scaffolded (placeholder empty states; not in product scope yet): Datasets, Evals, Analysis. Adding a backend route table for either pillar is net-new product work and explicitly out of scope through v0.5.x.
- Components: PendingMigrationsBanner, UpdateBanner, CopyableCode, PayloadShape (provider-aware payload renderer), SubmitModal, SuggestionEditor, DiffView, GithubNotConnectedDialog.
- Bundle: ~85 KB gzipped.
- Bundled into both SDKs at release time (`tools/sync-dashboard-dist.sh` for Python; per-SDK build for TS).
- **Tests:** vitest 85 passing across 12 files; Playwright E2E 15 passing across 4 specs (auth / samples / prompts / github), driven against the live Vite dev server which mounts the real SDK handler in-process.

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

For an authed call against `/api/judge` or `/api/analyze`, run `gravel doctor` from a wizard-installed project — it prints a working curl recipe with the API key + project id resolved from your `.env.local`.

## What's next

Open at the time of writing:

1. Datasets + Evals pillars — these are scaffolded as empty dashboard routes; the backend route table is net-new product surface (new SDK helpers, new tables, new dashboard pages) and needs a design pass before code.
2. Fixture suite end-to-end execution: the verifier-side journeys (`manifest:deep-scan`, raw-fetch tracing) are coded but the CI machine that runs `npm install` / `poetry install` across all 14 fixtures doesn't exist yet.
