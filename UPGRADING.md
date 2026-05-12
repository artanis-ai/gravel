# Upgrading Gravel

The TL;DR for any release:

```
gravel doctor                         # see what's available
pnpm update @artanis-ai/gravel@<v>    # (or your manager — gravel doctor prints the right one)
gravel migrate                        # if the release ships DB changes
```

For Python: `artanis-gravel doctor`, then `uv pip install --upgrade artanis-gravel==<v>` (or poetry/pipenv/pip), then `artanis-gravel migrate`.

This file is the canonical source of truth for everything that can break across an SDK upgrade. Skim the section for your target version before bumping.

---

## How the update journey works

Three surfaces all share the same source of truth (`getVersionInfo()` on the JS side, `doctor.get_version_info()` on Python):

1. **`gravel doctor` CLI.** Prints `current → latest`, detects your package manager from lockfiles in cwd, and emits exactly the right upgrade command for that stack. Exits non-zero if behind — use it in CI to fail loud when the host pin drifts. `--json` for scripting. `GRAVEL_VERSION_CHECK_DISABLED=1` to skip the registry hit.

2. **Dashboard banner (admin only).** Polls `/api/version` once on mount. On **loopback** (the developer's dev box) you see the actionable upgrade command. On **prod** (any non-loopback hostname) the command would be misleading — the operator viewing the dashboard usually isn't the deployer — so we swap to "ask your developer to update and redeploy".

3. **`gravel init` exit notice.** A one-line note at the end of the wizard if a newer version is available. Budget-capped at 3s so a slow registry never blocks the install.

If a release ships DB migrations, a second banner — **PendingMigrationsBanner** — appears with the count + the right migrate command for your stack.

## DB migrations

| Where | Behaviour |
| --- | --- |
| Dev (`NODE_ENV` ≠ `production`) | `openDatabase()` auto-applies pending drizzle-kit migrations on first connect. Skip with `GRAVEL_DISABLE_AUTO_MIGRATE=1`. |
| Prod (`NODE_ENV` = `production`) | Refuses to auto-migrate. Run `npx @artanis-ai/gravel migrate` (or `artanis-gravel migrate`) as a deploy step. |
| Detection | `/api/migrations/status` returns `{ pending, dialect, autoMigrate }`. The dashboard banner uses this to nag admins when the DB is behind. |

SQLite + first install: schema is created by `bootstrap()` (idempotent `CREATE TABLE IF NOT EXISTS`). Postgres has no bootstrap — first deploy MUST run `gravel migrate` or the first query 4xx's.

## Generated-code migrations (codegen)

`gravel init` writes ~5 files into your repo:

- `gravel.config.ts` / `gravel_config.py` — your config. Regenerated on every `gravel init`, so customisations get clobbered. **Don't hand-edit until we annotate user-editable regions** (issue tracked; for now, treat init as destructive on this file).
- `instrumentation.ts` — Next.js auto-tracing hook. Gitignored; regenerated freely.
- `next.config.{ts,mjs,js}` patches — `serverExternalPackages` + webpack externals. Idempotent: the wizard detects "already patched" by checking for our package names in the externals block.
- Dashboard mount route (`app/admin/ai/[[...slug]]/route.ts` or pages-router equivalent).
- Pre-commit hook (Husky → pre-commit-framework → native `.git/hooks/`).

If a release changes the shape of any of these, the migration path today is:

```
gravel init  # re-runs the wizard, which re-applies its patchers idempotently
```

This is "good enough" because the patchers are designed to be re-runnable. It is **not** "good enough" if you've customised `gravel.config.*` — back that up first. We'll grow proper versioned codemods once we actually ship a breaking codegen change.

Per-version migration notes (if any) live in the per-version sections below.

## Privacy + offline

Set `GRAVEL_VERSION_CHECK_DISABLED=1` in your env to disable all version-check network hits (npm registry / PyPI). Used by:

- The dashboard banner (skips the fetch, banner doesn't render).
- `gravel doctor` / `artanis-gravel doctor` (prints "unknown" for `latest`).
- The `gravel init` exit notice (skipped).

The check is also auto-suppressed in our own test suites via the same env var.

---

## v0.1.0 → v0.2.0 _(unreleased)_

_Nothing breaking yet. This section template ships with every release._

### What changed

(Bulleted summary, written like a user-facing release note.)

### Migration steps

1. Bump the version: `pnpm update @artanis-ai/gravel@0.2.0` (or whatever `gravel doctor` prints).
2. If DB migrations: `npx @artanis-ai/gravel migrate` (prod) or restart your dev server (auto-applies).
3. If codegen changes: re-run `gravel init`. Back up `gravel.config.*` first if you've customised it.

### Manual fix-ups (rare)

(If we ever ship a change that the patchers can't handle, the exact patch goes here.)
