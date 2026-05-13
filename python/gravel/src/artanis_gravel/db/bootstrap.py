"""Idempotent CREATE TABLE bootstrap. Stands in for Alembic revisions until
the schema stabilises enough to ship version-controlled migrations.

Mirrors packages/sdk-ts/src/db/bootstrap.ts. Schema-drift CI rejects mismatch.
"""
from __future__ import annotations

from sqlalchemy import Engine

from ..schema import metadata


def bootstrap(engine: Engine) -> None:
    """Create all gravel_* tables that don't exist. Idempotent."""
    metadata.create_all(engine)
