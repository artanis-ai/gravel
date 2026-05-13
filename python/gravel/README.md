# artanis-gravel

The Python SDK for [Gravel](https://gravel.artanis.ai).

**Status:** v0.5.x, live on PyPI.

```bash
uvx artanis-gravel init    # or `pipx run artanis-gravel init`
```

See [`/STATUS.md`](../../STATUS.md) for what's built and what's next.

## Layout

```
src/artanis_gravel/
├── __init__.py             # GravelConfig, GravelUser, defineConfig
├── auto.py                 # the import-side-effect tracing entry point
├── types.py
├── schema.py               # SQLAlchemy schema (gravel_samples + gravel_feedback)
├── db/                     # connector + bootstrap
├── auth.py                 # HMAC sessions + password verify
├── _handler.py             # shared framework-agnostic route dispatcher
├── _rate_limit.py          # per-IP login rate-limit bucket
├── _github_state.py        # GRAVEL_GH_INSTALL_* env read + CP token mint
├── _github_api.py          # multi-file PR REST flow
├── _prompts_submit.py      # drafts -> manifest rewrite -> PR
├── _env_writer.py          # .env.local writer used by the install callback
├── _migrations_status.py   # /api/migrations/status helper
├── version_check.py        # /api/version helper (importlib.metadata + PyPI)
├── manifest/               # .gravel/manifest.json read/write/scan + hook
├── tracing/                # OpenAI / Anthropic / LangChain + fetch_patch
├── fastapi.py              # FastAPI adapter over _handler.dispatch_request
├── django.py               # Django gravel_urls over the same dispatcher
├── flask.py                # Flask mount_on_flask via a2wsgi (extra: flask)
├── asgi.py                 # GravelAsgiApp + gravel_wsgi_app
└── _cli.py                 # binary-downloader wrapper around the Go CLI
```

## Schema parity

This package's SQLAlchemy schema is kept in lockstep with the TypeScript Drizzle schema in `packages/sdk-ts/src/schema/`. CI rejects drift.
