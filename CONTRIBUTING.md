# Contributing

Gravel is in active v0.5.x development. Both SDKs are on npm + PyPI; the API surface is settled for the dashboard routes and tracing patches but still evolving for the next pillars (Datasets, Evals). PRs welcome — please open an issue first for anything non-trivial so we don't both build the same thing.

## Dev setup

Prereqs:

- Node 20+, pnpm 9+.
- Python 3.10+, [uv](https://docs.astral.sh/uv/).
- Postgres 14+ (or SQLite for quick dev).

```bash
git clone https://github.com/artanis-ai/gravel.git
cd gravel
pnpm install            # installs TS workspace
cd python/gravel && uv sync && cd ../..
```

Running tests:

```bash
pnpm test                                # TS
cd python/gravel && uv run pytest        # Python
```

## Layout

See [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Schema drift

The TS and Python schemas have to match. If you change one, change the other in the same PR. CI will reject mismatched schemas (`.github/workflows/schema-drift.yml`).

## Pre-commit hooks

One-time setup per clone:

```bash
uv tool install pre-commit         # or `pip install pre-commit`
pre-commit install                  # fast checks on `git commit`
pre-commit install -t pre-push      # full test suites on `git push`
```

What runs when:

- **pre-commit** (every `git commit`, must be quick):
  - `tools/check-sdk-versions-in-sync.sh` — `python/gravel/pyproject.toml` and `packages/sdk-ts/package.json` must report the same version. Catches the failure mode where bumping one without the other leads to a tagged release that succeeds on one registry and 409s on the other.
  - `go vet ./...` in `cli/`.
  - `ruff check src` in `python/gravel/`.

- **pre-push** (every `git push`): the full `go test ./...` and `pytest tests/` suites plus the version-sync check again.

Bypass with `--no-verify` only when you genuinely know the check is wrong; the same version-sync check runs in CI (`.github/workflows/version-sync.yml`) so a bypassed local hook still gets caught at PR time.

## Releasing

`tools/release.sh vX.Y.Z` bumps the three version files (`cli/internal/version/version.go`, `packages/sdk-ts/package.json`, `python/gravel/pyproject.toml`) in lockstep, commits, tags, pushes. Don't hand-bump — the pre-commit hook will reject mismatches, and the publish workflows on the tag will fail on whichever side is stale.

## Commit style

Short imperative subject. Body explains *why*, not *what*. Tag area: `feat(sdk-ts): ...`, `fix(wizard): ...`, `docs: ...`.

## License

Apache 2.0. By submitting a PR you agree to license your contribution under the same terms.
