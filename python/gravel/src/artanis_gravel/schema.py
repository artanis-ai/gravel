"""SQLAlchemy schema. Source of truth for the gravel_* tables in the user's
database (data plane). Mirrors packages/sdk-ts/src/schema/postgres.ts.

CI rejects drift between this and the Drizzle schema. See
.github/workflows/schema-drift.yml.

Both Postgres and SQLite are supported via SQLAlchemy's dialect-agnostic types.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    MetaData,
    String,
    Table,
    UniqueConstraint,
    func,
)

metadata = MetaData()


def _ts(name: str, nullable: bool = False, default: bool = False) -> Column:
    col = Column(name, DateTime(timezone=True), nullable=nullable)
    if default:
        col = Column(name, DateTime(timezone=True), nullable=nullable, server_default=func.now())
    return col


# 1.1 gravel_projects
gravel_projects = Table(
    "gravel_projects",
    metadata,
    Column("id", String, primary_key=True),
    Column("name", String, nullable=False),
    Column("tier", String, nullable=False, server_default="free"),
    Column("credits_remaining", BigInteger, nullable=False, server_default="0"),
    Column("credits_refreshed_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
)

# 1.2 gravel_environments
gravel_environments = Table(
    "gravel_environments",
    metadata,
    Column("id", String, primary_key=True),
    Column("name", String, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    UniqueConstraint("name", name="gravel_environments_name_unique"),
)

# 1.3 gravel_users
gravel_users = Table(
    "gravel_users",
    metadata,
    Column("id", String, primary_key=True),
    Column("first_name", String, nullable=False),
    Column("role", String, nullable=False),
    Column("last_seen_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("extra", JSON),
)

# 1.4 gravel_traces
gravel_traces = Table(
    "gravel_traces",
    metadata,
    Column("id", String, primary_key=True),
    Column("name", String, nullable=False),
    Column("group_id", String),
    Column(
        "environment_id",
        String,
        ForeignKey("gravel_environments.id", ondelete="RESTRICT"),
        nullable=False,
    ),
    Column("metadata", JSON),
    Column("status", String, nullable=False, server_default="running"),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("completed_at", DateTime(timezone=True)),
    Column("duration_ms", BigInteger),
    Column("commit_sha", String),
    Column("prompt_id", String),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_traces_env_timestamp_idx", "environment_id", "timestamp"),
    Index("gravel_traces_prompt_id_idx", "prompt_id"),
)

# 1.5 gravel_observations
gravel_observations = Table(
    "gravel_observations",
    metadata,
    Column("id", String, primary_key=True),
    Column("trace_id", String, ForeignKey("gravel_traces.id", ondelete="CASCADE"), nullable=False),
    Column("type", String, nullable=False),
    Column("data", JSON, nullable=False),
    Column("key", String),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_observations_trace_timestamp_idx", "trace_id", "timestamp"),
)

# 1.6 gravel_feedback
gravel_feedback = Table(
    "gravel_feedback",
    metadata,
    Column("id", String, primary_key=True),
    Column("trace_id", String, ForeignKey("gravel_traces.id", ondelete="CASCADE")),
    Column("observation_id", String, ForeignKey("gravel_observations.id", ondelete="CASCADE")),
    Column("comment", String),
    Column("correction", String),
    Column("score", String),
    Column("source", String, nullable=False, server_default="ui"),
    Column("reporter_user_id", String, ForeignKey("gravel_users.id", ondelete="SET NULL")),
    Column("metadata", JSON),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_feedback_trace_id_idx", "trace_id"),
    Index("gravel_feedback_observation_id_idx", "observation_id"),
)

# 1.7 gravel_labels
gravel_labels = Table(
    "gravel_labels",
    metadata,
    Column("id", String, primary_key=True),
    Column(
        "observation_id",
        String,
        ForeignKey("gravel_observations.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("label_data", JSON, nullable=False),
    Column("timestamp", DateTime(timezone=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_labels_observation_id_idx", "observation_id"),
)

# 1.8 gravel_datasets
gravel_datasets = Table(
    "gravel_datasets",
    metadata,
    Column("id", String, primary_key=True),
    Column("name", String, nullable=False),
    Column("description", String),
    Column("environment_id", String, ForeignKey("gravel_environments.id", ondelete="SET NULL")),
    Column("created_by_user_id", String, ForeignKey("gravel_users.id", ondelete="SET NULL")),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("deleted_at", DateTime(timezone=True)),
)

# 1.9 gravel_dataset_traces
gravel_dataset_traces = Table(
    "gravel_dataset_traces",
    metadata,
    Column("id", String, primary_key=True),
    Column(
        "dataset_id",
        String,
        ForeignKey("gravel_datasets.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("trace_id", String, ForeignKey("gravel_traces.id", ondelete="CASCADE"), nullable=False),
    Column("added_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    UniqueConstraint("dataset_id", "trace_id", name="gravel_dataset_traces_unique"),
)

# 1.10 gravel_prompts
gravel_prompts = Table(
    "gravel_prompts",
    metadata,
    Column("id", String, primary_key=True),
    Column("path", String, nullable=False),
    Column("type", String, nullable=False),
    Column("segment", JSON),
    Column("current_hash", String, nullable=False),
    Column("current_text", String, nullable=False),
    Column("last_seen_commit", String, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_prompts_path_idx", "path"),
    Index("gravel_prompts_hash_idx", "current_hash"),
)

# 1.11 gravel_prompt_drafts
gravel_prompt_drafts = Table(
    "gravel_prompt_drafts",
    metadata,
    Column("id", String, primary_key=True),
    Column("prompt_id", String, ForeignKey("gravel_prompts.id", ondelete="CASCADE"), nullable=False),
    Column("draft_branch", String, nullable=False),
    Column("new_text", String, nullable=False),
    Column("editor_user_id", String, ForeignKey("gravel_users.id", ondelete="SET NULL")),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_prompt_drafts_branch_idx", "draft_branch"),
    Index("gravel_prompt_drafts_prompt_branch_idx", "prompt_id", "draft_branch"),
)

# 1.12 gravel_eval_runs
gravel_eval_runs = Table(
    "gravel_eval_runs",
    metadata,
    Column("id", String, primary_key=True),
    Column("dataset_id", String, ForeignKey("gravel_datasets.id", ondelete="CASCADE"), nullable=False),
    Column("type", String, nullable=False),
    Column("status", String, nullable=False, server_default="pending"),
    Column("triggered_by_user_id", String, ForeignKey("gravel_users.id", ondelete="SET NULL")),
    Column("commit_sha", String),
    Column(
        "target_environment_id",
        String,
        ForeignKey("gravel_environments.id", ondelete="SET NULL"),
    ),
    Column("total_rows", Integer, nullable=False, server_default="0"),
    Column("completed_rows", Integer, nullable=False, server_default="0"),
    Column("summary", JSON),
    Column("started_at", DateTime(timezone=True)),
    Column("completed_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_eval_runs_dataset_id_idx", "dataset_id"),
    Index("gravel_eval_runs_status_idx", "status"),
)

# 1.13 gravel_eval_results
gravel_eval_results = Table(
    "gravel_eval_results",
    metadata,
    Column("id", String, primary_key=True),
    Column("eval_run_id", String, ForeignKey("gravel_eval_runs.id", ondelete="CASCADE"), nullable=False),
    Column(
        "dataset_trace_id",
        String,
        ForeignKey("gravel_dataset_traces.id", ondelete="SET NULL"),
    ),
    Column("trace_id", String, ForeignKey("gravel_traces.id", ondelete="SET NULL")),
    Column("live_output", JSON),
    Column("verdict", JSON, nullable=False),
    Column("judge_call_ms", Integer),
    Column("pipeline_call_ms", Integer),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("gravel_eval_results_run_id_idx", "eval_run_id"),
)

ALL_TABLES = [
    gravel_projects,
    gravel_environments,
    gravel_users,
    gravel_traces,
    gravel_observations,
    gravel_feedback,
    gravel_labels,
    gravel_datasets,
    gravel_dataset_traces,
    gravel_prompts,
    gravel_prompt_drafts,
    gravel_eval_runs,
    gravel_eval_results,
]
