# Migrations

Drizzle-kit-generated migrations for the gravel_* tables. Two parallel sets:

- `postgres/` — for `DATABASE_URL` starting with `postgres://` / `postgresql://`.
- `sqlite/` — for `file:` / `sqlite:` URLs.

Both are generated from the matching schema file in `src/schema/`. They're checked in. The lib's runtime migration runner picks the right set based on the dialect detected at boot.

## Regenerating

After editing `src/schema/postgres.ts` or `sqlite.ts`:

```bash
pnpm exec drizzle-kit generate --config=drizzle.config.postgres.ts
pnpm exec drizzle-kit generate --config=drizzle.config.sqlite.ts
```

Commit both. Schema-drift CI verifies they describe the same logical schema as the Python SQLAlchemy side.

## v0.0.1 initial migration

The first generated migration files in this directory will be `0000_initial.sql` once `drizzle-kit generate` is run. Until then, the lib falls back to the idempotent `bootstrap.ts` script (also kept around for tests).

**This README is a placeholder until that first generate-run lands.** During the v0 build session, the migration scaffolding was wired up but the actual generated SQL files are produced by running drizzle-kit (which needs a DATABASE_URL it can introspect, so we run it locally / in CI rather than checking the auto-generated SQL into the repo from a clean machine).

To run the first generate locally:

```bash
cd packages/sdk-ts
DATABASE_URL=postgresql://localhost/gravel_dev pnpm exec drizzle-kit generate --config=drizzle.config.postgres.ts
DATABASE_URL=file:./gravel-tmp.db pnpm exec drizzle-kit generate --config=drizzle.config.sqlite.ts
git add migrations/
```
