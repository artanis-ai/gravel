"""Idempotent CREATE TABLE bootstrap. v0 substitute for proper Alembic migrations.

Mirrors packages/sdk-ts/src/db/bootstrap.ts. Schema-drift CI rejects mismatch.

When proper migrations are wired up (BLOCKER in gravel-cloud/docs/blockers.md
§schema), this is replaced by Alembic.
"""
from __future__ import annotations

from sqlalchemy import Engine

from ..schema import metadata


def bootstrap(engine: Engine) -> None:
    """Create all gravel_* tables that don't exist. Idempotent."""
    metadata.create_all(engine)
