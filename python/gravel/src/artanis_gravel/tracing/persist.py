"""Persistence helper — writes a captured sample (one LLM call) to the user's
database via SQLAlchemy.

The patches call `persist_trace(record)` after capturing input/output. We keep
this synchronous + best-effort: a logged warning on failure, never a raise into
user code (spec §6 — tracing must be invisible from a perf standpoint and never
break the caller).

2026-05-08 (D-Q53): the customer-side data plane is two tables —
`gravel_samples` (the unit; one row per LLM call) and `gravel_feedback`. The
old `gravel_traces` + `gravel_observations` split collapsed into the sample's
`input` / `output` / `metadata` jsonb columns. The TraceRecord / Observation
in-memory shape stays for the patch sites' compat — `persist_trace` flattens
the input/output observations into the sample row and pushes any
state/error observations into `metadata.states` / `metadata.error`.
"""
from __future__ import annotations

import dataclasses
import logging
import os
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from sqlalchemy import Engine
from sqlalchemy.exc import SQLAlchemyError

from ..schema import gravel_samples

log = logging.getLogger("gravel.tracing")


# ---------- public records ----------


@dataclass
class ObservationRecord:
    """One observation row — kept for back-compat with patch call sites.

    `input` and `output` types are flattened into the sample's `input` / `output`
    jsonb columns at write time. `state` and `error` types are merged into the
    sample's `metadata.states` list (and `metadata.error` for error keys).
    """

    type: str  # 'input' | 'output' | 'state' | 'error'
    data: dict[str, Any]
    key: str | None = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class TraceRecord:
    """A full trace + its observations, ready to flush to the DB."""

    name: str
    started_at: datetime
    completed_at: datetime
    status: str  # 'ok' | 'errored'
    observations: list[ObservationRecord] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    model: str | None = None
    commit_sha: str | None = None
    prompt_id: str | None = None
    group_id: str | None = None
    environment_id: str | None = None  # resolved from config if None

    @property
    def duration_ms(self) -> int:
        delta = self.completed_at - self.started_at
        return max(0, int(delta.total_seconds() * 1000))


# ---------- config wiring ----------


@dataclass
class TracingRuntimeConfig:
    engine: Engine
    environment_id: str = "prod"
    table_prefix: str = "gravel_"
    scrub_input: Callable[[Any], Any] | None = None
    scrub_output: Callable[[Any], Any] | None = None


_runtime_lock = threading.Lock()
_runtime: TracingRuntimeConfig | None = None


def set_gravel_tracing_config(config: TracingRuntimeConfig | None) -> None:
    """Install (or clear) the runtime config the persister uses.

    Called from the wizard-emitted bootstrap or directly by the user's app
    when their `define_config(...)` is fully resolved. Pass `None` to
    teardown (mostly used in tests).
    """
    global _runtime
    with _runtime_lock:
        _runtime = config


def get_gravel_tracing_config() -> TracingRuntimeConfig | None:
    return _runtime


# ---------- write path ----------


def _resolve_env(record: TraceRecord, runtime: TracingRuntimeConfig) -> str:
    if record.environment_id:
        return record.environment_id
    return os.environ.get("GRAVEL_ENVIRONMENT") or runtime.environment_id


def _scrub(record: TraceRecord, runtime: TracingRuntimeConfig) -> None:
    """Apply user-configured PII scrubbers in place. Errors are swallowed and
    logged — a broken scrubber must not block the write or the LLM call."""
    if runtime.scrub_input:
        for obs in record.observations:
            if obs.type == "input":
                try:
                    obs.data = {**obs.data, "messages": runtime.scrub_input(obs.data.get("messages"))}
                except Exception as exc:  # noqa: BLE001 — scrubbers are user code; never trust
                    log.warning("scrub_input raised; passing through unscrubbed: %s", exc)
    if runtime.scrub_output:
        for obs in record.observations:
            if obs.type == "output":
                try:
                    obs.data = runtime.scrub_output(obs.data) or obs.data
                except Exception as exc:  # noqa: BLE001 — same rationale
                    log.warning("scrub_output raised; passing through unscrubbed: %s", exc)


def _flatten(record: TraceRecord) -> tuple[Any, Any, dict[str, Any]]:
    """Collapse the (compat) observation list into the sample's three jsonb
    columns. Returns (input, output, metadata)."""
    input_data: Any = None
    output_data: Any = None
    states: list[dict[str, Any]] = []
    error: str | None = None
    for obs in record.observations:
        if obs.type == "input":
            input_data = obs.data
        elif obs.type == "output":
            output_data = obs.data
        elif obs.type == "error":
            states.append({"key": obs.key or "error", "data": obs.data})
            error = error or (obs.data.get("message") if isinstance(obs.data, dict) else None)
        else:  # 'state' or anything else — treat as auxiliary state
            states.append({"key": obs.key, "data": obs.data})
    metadata: dict[str, Any] = dict(record.metadata or {})
    if states:
        metadata.setdefault("states", states)
    if error and "error" not in metadata:
        metadata["error"] = error
    return input_data, output_data, metadata


def persist_trace(record: TraceRecord) -> str | None:
    """Insert one sample row. Returns the sample id on success.

    Best-effort: returns `None` on any error (DB down, no runtime configured,
    table missing) and logs a warning. Never raises into caller code.
    """
    runtime = _runtime
    if runtime is None:
        log.debug("persist_trace called before set_gravel_tracing_config; dropping")
        return None

    _scrub(record, runtime)

    sample_id = uuid.uuid4().hex
    env_id = _resolve_env(record, runtime)
    input_data, output_data, metadata = _flatten(record)

    status = "errored" if record.status == "errored" else "completed"

    try:
        with runtime.engine.begin() as conn:
            conn.execute(
                gravel_samples.insert().values(
                    id=sample_id,
                    name=record.name,
                    group_id=record.group_id,
                    environment=env_id,
                    model=record.model,
                    status=status,
                    input=input_data,
                    output=output_data,
                    metadata=metadata or None,
                    timestamp=record.started_at,
                    started_at=record.started_at,
                    completed_at=record.completed_at,
                    duration_ms=record.duration_ms,
                    commit_sha=record.commit_sha,
                    prompt_id=record.prompt_id,
                )
            )
    except SQLAlchemyError as exc:
        log.warning("failed to persist sample %s: %s", record.name, exc)
        return None
    return sample_id


def persist_traces(records: Iterable[TraceRecord]) -> list[str]:
    """Bulk wrapper. Returns the list of successfully-written sample ids."""
    out: list[str] = []
    for r in records:
        sid = persist_trace(r)
        if sid is not None:
            out.append(sid)
    return out


# ---------- helpers used by patches ----------


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def make_record(
    name: str,
    started_at: datetime,
    completed_at: datetime,
    *,
    model: str | None,
    status: str,
    input_data: dict[str, Any] | None = None,
    output_data: dict[str, Any] | None = None,
    error_data: dict[str, Any] | None = None,
    extra_observations: list[ObservationRecord] | None = None,
    metadata: dict[str, Any] | None = None,
) -> TraceRecord:
    """Convenience constructor used by every provider patch — keeps the
    captured shape consistent."""
    obs: list[ObservationRecord] = []
    if input_data is not None:
        obs.append(ObservationRecord(type="input", data=input_data, key="input"))
    if output_data is not None:
        obs.append(ObservationRecord(type="output", data=output_data, key="output"))
    if error_data is not None:
        obs.append(ObservationRecord(type="error", data=error_data, key="error"))
    if extra_observations:
        obs.extend(extra_observations)

    meta = dict(metadata or {})
    if model and "model" not in meta:
        meta["model"] = model

    return TraceRecord(
        name=name,
        started_at=started_at,
        completed_at=completed_at,
        status=status,
        observations=obs,
        metadata=meta,
        model=model,
    )


def record_to_dict(record: TraceRecord) -> dict[str, Any]:
    """Debug helper — used by tests."""
    d = dataclasses.asdict(record)
    d["duration_ms"] = record.duration_ms
    return d
