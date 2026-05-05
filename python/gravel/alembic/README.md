# Alembic migrations

Migrations for the gravel_* tables on the Python side.

## Generating

After editing `src/artanis_gravel/schema.py`:

```bash
cd python/gravel
DATABASE_URL=postgresql://localhost/gravel_dev uv run alembic revision --autogenerate -m "your message"
```

Commit the generated file in `alembic/versions/`.

## Applying

```bash
DATABASE_URL=postgresql://... uv run alembic upgrade head
```

The lib's runtime auto-applies migrations in dev (per `data-model.md §3.4`); in prod, users run `python -m artanis_gravel migrate` as a deploy step.

## v0.0.1 initial migration

Until the first `alembic revision --autogenerate` is run, the lib falls back to `metadata.create_all` from `db/bootstrap.py` (idempotent CREATE TABLE IF NOT EXISTS). Same fallback as the TS side.
