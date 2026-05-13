# Migrations

Schema bootstrap for the `gravel_*` tables.

## Current behaviour (v0.5.x): bootstrap, not migrations

The gravel SDK's data-plane schema is small (two tables: `gravel_samples` + `gravel_feedback`) and idempotent CREATE-TABLE-IF-NOT-EXISTS via `src/db/bootstrap.ts` is the source of truth right now. Every customer install runs it on first DB open; `pendingMigrationCount` (see `src/db/migrate.ts`) returns 0 until an actual generated migration lands.

For Python, the equivalent runs through `python/gravel/src/artanis_gravel/db/bootstrap.py` and Alembic is configured but ships with zero revisions for the same reason.

## Why no drizzle-kit migrations yet

A schema that's still settling (the May 2026 `D-Q53` simplification dropped traces/users/datasets/evals/observations down to two tables) doesn't benefit from version-controlled migrations — every change would force a rewrite. Once the surface stabilises we'll start checking in `drizzle-kit generate` output here and Alembic revisions under `python/gravel/alembic/versions/`.

## Regenerating (once revisions start landing)

After editing `src/schema/postgres.ts` or `sqlite.ts`:

```bash
cd packages/sdk-ts
DATABASE_URL=postgresql://localhost/gravel_dev pnpm run migrations:generate
git add migrations/
```

Commit both `postgres/` and `sqlite/` outputs. Schema-drift CI (`.github/workflows/schema-drift.yml`) verifies the two dialects + the Python SQLAlchemy schema describe the same logical shape.

## Dashboard hook

The dashboard's `PendingMigrationsBanner` polls `GET /api/migrations/status`. Today it always reports `{ pending: 0, dialect, autoMigrate }` because no revisions are bundled; once that changes, an admin viewing the dashboard sees a banner with the count + the right upgrade command for their package manager.
