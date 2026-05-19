"""SQLAlchemy schema. Source of truth for the gravel_* tables in the
customer's database (data plane). Mirrors
packages/sdk-ts/src/schema/postgres.ts.

CI rejects drift between this and the Drizzle schema. See
.github/workflows/schema-drift.yml.

2026-05-08 simplification (D-Q53): three tables. Traces became samples;
samples carry their own input/output jsonb. Users + datasets + evals
+ observations tables retired until the corresponding UI ships.

2026-05-13 (v0.5.23): timestamp columns switched from `DateTime` to
`GravelTimestamp` (custom TypeDecorator). The Go-side bootstrap SQL
(`cli/internal/migrate/sql/sqlite_bootstrap.sql`) creates these
columns as INTEGER (unix ms) on SQLite — matching the TS Drizzle
SQLite schema, which always used int. Python's previous `DateTime`
declaration created a silent cross-stack drift: SQLAlchemy serialised
writes to ISO TEXT (SQLite stored them despite the INTEGER affinity)
but the `created_at` server-default `(unixepoch() * 1000)` produced
a real int, and on read SQLAlchemy's DateTime processor blew up with
`fromisoformat: argument must be str` when it hit the int column.
The new TypeDecorator: BIGINT on SQLite, TIMESTAMPTZ on Postgres
(both matching the Go bootstrap); bind converts datetime → int(ms)
for SQLite; result accepts int / datetime / legacy ISO-string and
always returns datetime. The schema-drift CI was blind to this
because `dump.ts` only inspects `postgres.ts`, not `sqlite.ts` or
the Go bootstrap SQL.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    ForeignKey,
    Index,
    JSON,
    MetaData,
    String,
    Table,
)
from sqlalchemy.types import TypeDecorator


class GravelTimestamp(TypeDecorator):
    """Cross-dialect timestamp column for the gravel_* tables.

    - Storage: int unix-ms on SQLite (matches the Go SDK's bootstrap
      DDL `INTEGER NOT NULL DEFAULT (unixepoch() * 1000)`), native
      TIMESTAMPTZ on Postgres (matches the Go bootstrap `TIMESTAMPTZ`).
    - Bind side accepts datetime or int and produces the right shape
      for the underlying dialect; the persister stays dialect-free.
    - Result side accepts int (new format), datetime (Postgres),
      string (pre-v0.5.23 SQLite rows where SQLAlchemy serialised
      datetime → ISO text into the INTEGER-affinity column) and
      always returns a timezone-aware datetime.
    - None passes through unchanged.

    Tests live in `tests/test_schema_timestamp.py`.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def load_dialect_impl(self, dialect: Any) -> Any:
        if dialect.name == "sqlite":
            return dialect.type_descriptor(BigInteger())
        return dialect.type_descriptor(DateTime(timezone=True))

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        if dialect.name == "sqlite":
            if isinstance(value, (int, float)):
                return int(value)
            if hasattr(value, "timestamp"):
                return int(value.timestamp() * 1000)
            if isinstance(value, str):
                # The dashboard's `from_` / `to` filter params arrive as
                # YYYY-MM-DD or full ISO strings — parse to int(ms) so
                # comparisons against the BIGINT storage work. Falls
                # back to passthrough on parse failure (the query will
                # then match nothing rather than 500).
                try:
                    return int(datetime.fromisoformat(value).timestamp() * 1000)
                except ValueError:
                    return value
            return value
        # Non-sqlite (Postgres): columns are TIMESTAMPTZ. The default
        # factory `_now_utc_ms()` returns int(ms) — Postgres rejects
        # that with "column 'created_at' is of type timestamp with time
        # zone but expression is of type bigint" (Olly #19 / v0.6.2
        # silent zero-row bug). Convert int(ms) → tz-aware datetime so
        # the persister stays dialect-free.
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        if isinstance(value, str):
            # Dashboard filter params (YYYY-MM-DD / ISO) — parse to
            # datetime so the WHERE clause compares apples to apples.
            try:
                return datetime.fromisoformat(value)
            except ValueError:
                return value
        return value

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        if isinstance(value, str):
            # Pre-v0.5.23 rows: persister wrote datetime → SQLAlchemy
            # serialised to ISO text; SQLite accepted the TEXT into
            # the INTEGER-affinity column (loose typing). Parse it back.
            try:
                return datetime.fromisoformat(value)
            except ValueError:
                return None
        return value


def _now_utc_ms() -> int:
    """Default factory for created_at when the SDK bootstraps a fresh
    SQLAlchemy-managed DB. The Go bootstrap supplies `unixepoch() * 1000`
    as a server-side default; this Python-side default matches the
    same shape for engines created via `metadata.create_all`."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)

metadata = MetaData()


# gravel_samples — one row per LLM call. group_id links samples into a
# multi-step "trace" (a virtual grouping; no separate trace table).
gravel_samples = Table(
    "gravel_samples",
    metadata,
    Column("id", String, primary_key=True),
    Column("name", String, nullable=False),
    Column("group_id", String),
    Column("environment", String),
    Column("model", String),
    Column("status", String, nullable=False, server_default="completed"),
    Column("input", JSON),
    Column("output", JSON),
    Column("metadata", JSON),
    Column("timestamp", GravelTimestamp, nullable=False),
    Column("started_at", GravelTimestamp, nullable=False),
    Column("completed_at", GravelTimestamp),
    Column("duration_ms", BigInteger),
    Column("commit_sha", String),
    Column("prompt_id", String),
    Column("created_at", GravelTimestamp, nullable=False, default=_now_utc_ms),
    Index("gravel_samples_env_timestamp_idx", "environment", "timestamp"),
    Index("gravel_samples_group_id_idx", "group_id"),
    Index("gravel_samples_prompt_id_idx", "prompt_id"),
)

gravel_feedback = Table(
    "gravel_feedback",
    metadata,
    Column("id", String, primary_key=True),
    Column("sample_id", String, ForeignKey("gravel_samples.id", ondelete="CASCADE"), nullable=False),
    Column("comment", String),
    Column("correction", String),
    Column("score", String),
    Column("source", String, nullable=False, server_default="ui"),
    Column("reporter_user_id", String),
    Column("metadata", JSON),
    Column("timestamp", GravelTimestamp, nullable=False),
    Column("created_at", GravelTimestamp, nullable=False, default=_now_utc_ms),
    Index("gravel_feedback_sample_id_idx", "sample_id"),
)

# (gravel_prompt_drafts dropped 2026-05-08; drafts live in the
# browser's localStorage, scoped per user. Submit endpoint accepts
# them inline in the request body.)

ALL_TABLES = [
    gravel_samples,
    gravel_feedback,
]
