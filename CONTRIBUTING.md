# Contributing

This repo is pre-v0. Code is in heavy flux. PRs are welcome but please open an issue first to discuss anything non-trivial — we're shaping the API surface as we go.

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

## Commit style

Short imperative subject. Body explains *why*, not *what*. Tag area: `feat(sdk-ts): ...`, `fix(wizard): ...`, `docs: ...`.

## License

Apache 2.0. By submitting a PR you agree to license your contribution under the same terms.
