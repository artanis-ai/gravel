# artanis-gravel

The Python SDK for [Gravel](https://gravel.artanis.ai).

**Status:** pre-v0. Not on PyPI yet.

```bash
# What this will look like once v0 ships:
python -m artanis_gravel init
```

See [`/STATUS.md`](../../STATUS.md) for what's built and what's next.

## Layout

```
src/artanis_gravel/
├── __init__.py             # GravelConfig, GravelUser, defineConfig
├── auto.py                 # the import-side-effect tracing entry point
├── types.py
├── schema.py               # SQLAlchemy schema for gravel_* tables
├── db/                     # connector + bootstrap
├── auth/                   # default password mode + getUser delegation
├── handler/                # core HTTP handler + route table
├── manifest/               # .gravel/manifest.json read/write/scan + hook
├── tracing/                # auto-patches for OpenAI/Anthropic/etc.
├── fastapi.py              # create_gravel_router(config) for FastAPI
├── django.py               # gravel_urls for Django
├── asgi.py                 # generic ASGI / WSGI handler
└── cli/                    # init, migrate, manifest, scan
```

## Schema parity

This package's SQLAlchemy schema is kept in lockstep with the TypeScript Drizzle schema in `packages/sdk-ts/src/schema/`. CI rejects drift.
