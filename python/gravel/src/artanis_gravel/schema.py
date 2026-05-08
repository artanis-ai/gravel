"""SQLAlchemy schema. Source of truth for the gravel_* tables in the
customer's database (data plane). Mirrors
packages/sdk-ts/src/schema/postgres.ts.

CI rejects drift between this and the Drizzle schema. See
.github/workflows/schema-drift.yml.

2026-05-08 simplification (D-Q53): three tables. Traces became samples;
samples carry their own input/output jsonb. Users + datasets + evals
+ observations tables retired until the corresponding UI ships.
"""
from __future__ import annotations

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
    UniqueConstraint,
    func,
)

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
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("completed_at", DateTime(timezone=True)),
    Column("duration_ms", BigInteger),
    Column("commit_sha", String),
    Column("prompt_id", String),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
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
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_feedback_sample_id_idx", "sample_id"),
)

gravel_prompt_drafts = Table(
    "gravel_prompt_drafts",
    metadata,
    Column("id", String, primary_key=True),
    Column("prompt_id", String, nullable=False),
    Column("draft_branch", String, nullable=False),
    Column("new_text", String, nullable=False),
    Column("editor_user_id", String),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_prompt_drafts_branch_idx", "draft_branch"),
    Index("gravel_prompt_drafts_prompt_branch_idx", "prompt_id", "draft_branch"),
    UniqueConstraint("prompt_id", "draft_branch", name="gravel_prompt_drafts_prompt_branch_unique"),
)

ALL_TABLES = [
    gravel_samples,
    gravel_feedback,
    gravel_prompt_drafts,
]
