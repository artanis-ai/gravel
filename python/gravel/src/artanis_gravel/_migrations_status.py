"""Pending-migrations status for the dashboard banner.

Port of `packages/sdk-ts/src/db/migrate.ts` (`pendingMigrationCount` +
`shouldAutoMigrate`), Python-side. The TS SDK ships drizzle-kit
migrations under `migrations/<dialect>/`; the Python SDK uses Alembic,
with revisions under `alembic/versions/`.

Counts work the same way: file-count under versions/ minus the count
recorded in Alembic's `alembic_version` table. The banner only cares
about the integer, not which revisions specifically are pending.

If anything goes wrong (table missing, dialect detection fails, files
unreadable) we return 0 rather than nag the user with a false-positive
banner — same conservative bias the TS side has.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from .db import detect_dialect


def should_auto_migrate(env: dict[str, str] | None = None) -> bool:
    """Same precedence as the TS side:

      * `GRAVEL_DISABLE_AUTO_MIGRATE=1` always wins (kill switch).
      * Production (`PYTHON_ENV=production` or the more common
        `NODE_ENV=production` in mixed-stack hosts) refuses auto-apply.
      * Everything else allows it.
    """
    e = env if env is not None else os.environ
    if e.get("GRAVEL_DISABLE_AUTO_MIGRATE") == "1":
        return False
    if e.get("PYTHON_ENV") == "production" or e.get("NODE_ENV") == "production":
        return False
    return True


def _alembic_versions_dir() -> Path:
    """Where the SDK's bundled Alembic revisions live. Defaults to the
    in-tree `alembic/versions/` next to the package's pyproject; the
    `GRAVEL_ALEMBIC_VERSIONS_DIR` env var overrides for tests."""
    override = os.environ.get("GRAVEL_ALEMBIC_VERSIONS_DIR")
    if override:
        return Path(override)
    # The SDK's pyproject lives at python/gravel/, and the alembic dir is
    # next to it. From this file (artanis_gravel/_migrations_status.py)
    # that's three parents up.
    here = Path(__file__).resolve()
    return here.parent.parent.parent / "alembic" / "versions"


def _count_revision_files(versions_dir: Path) -> int:
    """How many `.py` revision files Alembic would consider. Excludes
    `__init__.py` and dotfiles. Returns 0 if the directory is missing."""
    if not versions_dir.is_dir():
        return 0
    count = 0
    for entry in versions_dir.iterdir():
        if not entry.is_file():
            continue
        name = entry.name
        if not name.endswith(".py") or name.startswith("_") or name.startswith("."):
            continue
        count += 1
    return count


def _applied_count(engine: Engine) -> int:
    """Count rows in `alembic_version`. Missing table → 0 applied,
    which means every bundled revision is reported as pending. That
    matches the TS approximation."""
    try:
        with engine.connect() as conn:
            r: Any = conn.execute(text("SELECT COUNT(*) AS n FROM alembic_version"))
            row = r.fetchone()
            if row is None:
                return 0
            return int(row[0])
    except Exception:
        return 0


def pending_migration_count(engine: Engine | None) -> int:
    """How many bundled revisions exist that haven't been applied to
    `engine`. Returns 0 on no DB, no bundled revisions, or any error."""
    if engine is None:
        return 0
    files = _count_revision_files(_alembic_versions_dir())
    if files == 0:
        return 0
    applied = _applied_count(engine)
    return max(0, files - applied)


def dialect_of(engine: Engine | None) -> str | None:
    """Return 'postgres' / 'sqlite' / None. Falls back to None when
    the engine URL doesn't match either family — same shape the
    dashboard expects so the banner can suppress itself."""
    if engine is None:
        return None
    try:
        return detect_dialect(str(engine.url))
    except Exception:
        # SQLAlchemy URL has its own dialect name we can fall back to.
        name = getattr(engine.dialect, "name", None)
        if isinstance(name, str):
            if name.startswith("postgres"):
                return "postgres"
            if name == "sqlite":
                return "sqlite"
        return None


def migrations_status(engine: Engine | None) -> dict[str, Any]:
    """The full payload the `/api/migrations/status` route returns.
    Includes a `reason` field when degraded so the dashboard can show
    the right copy ("no DB configured" vs. "migrations up to date")."""
    if engine is None:
        return {
            "pending": 0,
            "dialect": None,
            "autoMigrate": should_auto_migrate(),
            "reason": "no-db",
        }
    return {
        "pending": pending_migration_count(engine),
        "dialect": dialect_of(engine),
        "autoMigrate": should_auto_migrate(),
    }


# Guard against stray re-imports in tests; keeps the public API minimal.
_ = re
