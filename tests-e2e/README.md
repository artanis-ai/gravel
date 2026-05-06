# tests-e2e — Playwright smoke for the Gravel SDK

End-to-end smoke that exercises the SDK + bundled dashboard SPA in a real
browser. Catches failure modes that unit tests miss: HTML asset rewriting,
content-type / status of bundled assets, and the auth cookie roundtrip
through actual fetch + form submission.

## Layout

```
tests-e2e/
├── package.json          # @playwright/test (scoped here, not in repo root)
├── playwright.config.ts  # one Chromium project, headless, with webServer
├── e2e/
│   ├── login-and-render.spec.ts   # browser flow + asset checks
│   └── api-roundtrip.spec.ts      # JSON API + cookie auth
└── test-app/
    ├── package.json      # workspace-links @artanis-ai/gravel
    └── src/server.ts     # Hono + @hono/node-server, mounts the SDK at /admin/ai
```

The `test-app` is intentionally minimal — it does NOT depend on the
control plane, Postgres, or any external service. SQLite (`file:./test.db`,
wiped at boot) + default-password mode (`GRAVEL_ADMIN_PASSWORD`) keeps it
self-contained.

## Run locally

From the **repo root**:

```bash
# 1. Install all workspace deps (one time / after lockfile changes).
pnpm install

# 2. Build the SDK (this also rebuilds the dashboard bundle via
#    packages/sdk-ts/scripts/build-dashboard.mjs).
pnpm --filter @artanis-ai/gravel build

# 3. Install the Chromium browser Playwright drives.
pnpm --filter gravel-tests-e2e exec playwright install --with-deps chromium

# 4. Run the suite. Playwright's webServer auto-starts the test-app.
pnpm --filter gravel-tests-e2e test
```

To watch the browser, swap step 4 for `pnpm --filter gravel-tests-e2e test:headed`.

## What it covers

- **`login-and-render.spec.ts`**
  - Unauth `/admin/ai/` 302s to `/admin/ai/login`.
  - Login form POST 303s back to `/admin/ai/`, React mounts into `#root`,
    and the empty-state copy ("No prompts yet") renders — proving the
    full SPA bootstraps.
  - At least one bundled `/_assets/*.js` request returns 200 with a
    `javascript` content-type — proving asset rewriting + serving works.

- **`api-roundtrip.spec.ts`**
  - JSON `POST /api/auth/login` issues a `gravel_session` cookie.
  - Cookie-authed `GET /api/auth/me` returns `{user, productName, mountPath}`.
  - `GET /api/prompts` returns `{prompts: [], last_scan_at: null}` (empty
    manifest is the canonical fixture state).
  - Bad password → 401. Unauthed `/api/auth/me` → 401.

## What it does NOT cover

By design, this is a smoke. Deep coverage (manifest scanning, draft flow,
PR submission, GitHub OAuth, tracing) lives in vitest under
`packages/sdk-ts/tests/`.
