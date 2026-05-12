# Upgrading Gravel

Two things upgrade independently:

1. **The `gravel` CLI binary** (this is what `gravel doctor` checks).
2. **The SDK library** pinned in your `package.json` / `pyproject.toml`.

They share a version number on each release (the release pipeline bumps them in lockstep), but they're installed and upgraded through different channels.

### TL;DR for any release

```
gravel doctor                                                       # see what's available
curl -fsSL https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh | sh   # upgrade the CLI
pnpm update @artanis-ai/gravel@<v>                                  # upgrade the SDK (or your stack's command)
gravel migrate                                                      # if the release ships DB changes
```

Python SDK: `uv pip install --upgrade artanis-gravel==<v>` (or poetry/pipenv/pip).

This file is the canonical source of truth for everything that can break across an upgrade. Skim the section for your target version before bumping.

---

## How the update journey works

Two surfaces, each owning one thing:

1. **`gravel doctor` CLI**. Checks the binary's version against the latest GitHub Release. If behind, prints the `curl | sh` install line (stack-agnostic, the binary lives outside your project's package manager). Detects your host stack (lockfiles in cwd) for informational reporting. Exits non-zero if behind, use it in CI to fail loud when the binary pin drifts. `--json` for scripting. `GRAVEL_VERSION_CHECK_DISABLED=1` to skip the GitHub API hit.

2. **Dashboard banner (admin only)**. Reads the SDK version from your `package.json` / `pyproject.toml`, polls `/api/version` once on mount. On **loopback** (the developer's dev box) you see the actionable per-stack upgrade command. On **prod** (any non-loopback hostname) the command would be misleading (the operator viewing the dashboard usually isn't the deployer), so we swap to "ask your developer to update and redeploy".

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

1. Upgrade the CLI binary: `curl -fsSL https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh | sh`.
2. Upgrade the SDK: `pnpm update @artanis-ai/gravel@0.2.0` (or whatever your stack's manager wants; the dashboard's loopback banner shows the exact line for your `package.json` / `pyproject.toml`).
3. If DB migrations: `gravel migrate` (prod) or restart your dev server (auto-applies).
4. If codegen changes: re-run `gravel init`. Back up `gravel.config.*` first if you've customised it.

### Manual fix-ups (rare)

(If we ever ship a change that the patchers can't handle, the exact patch goes here.)
