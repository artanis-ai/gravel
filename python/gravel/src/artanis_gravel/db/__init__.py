"""DB connector — SQLAlchemy. Engine for Postgres or SQLite based on URL.

Mirrors packages/sdk-ts/src/db/index.ts.
"""
from __future__ import annotations

from sqlalchemy import Engine, create_engine


def detect_dialect(url: str) -> str:
    if url.startswith(("postgres://", "postgresql://")):
        return "postgres"
    if url.startswith(("sqlite:", "file:")) or url.endswith((".db", ".sqlite")):
        return "sqlite"
    raise ValueError(
        f"[gravel] Unsupported DATABASE_URL: {url}. Use postgresql:// or sqlite:/file:."
    )


def open_database(url: str) -> Engine:
    dialect = detect_dialect(url)
    if dialect == "postgres":
        # Normalize the legacy postgres:// scheme to postgresql:// for SQLAlchemy.
        if url.startswith("postgres://"):
            url = "postgresql://" + url[len("postgres://"):]
        return create_engine(url, pool_pre_ping=True)
    if dialect == "sqlite":
        path = url.replace("file:", "").replace("sqlite:", "")
        engine = create_engine(f"sqlite:///{path}")
        return engine
    raise AssertionError("unreachable")
