"""Unit tests for `artanis_gravel.tracing` (the public context API)
and `artanis_gravel.tracing.persist`.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import create_engine, select

from artanis_gravel.schema import gravel_samples, metadata as schema_metadata
from artanis_gravel.tracing import (
    awith_gravel_metadata,
    awith_tracing_disabled,
    gravel_context,
    gravel_context_singleton,
    set_gravel_tracing_config,
    with_gravel_metadata,
    with_tracing_disabled,
)
from artanis_gravel.tracing.persist import (
    ObservationRecord,
    TracingRuntimeConfig,
    make_record,
    now_utc,
    persist_trace,
)


# ---------- context API ----------


def test_metadata_merges_across_nested_blocks() -> None:
    with with_gravel_metadata({"a": 1}):
        assert gravel_context_singleton.get_metadata() == {"a": 1}
        with with_gravel_metadata({"b": 2}):
            assert gravel_context_singleton.get_metadata() == {"a": 1, "b": 2}
        assert gravel_context_singleton.get_metadata() == {"a": 1}
    assert gravel_context_singleton.get_metadata() == {}


def test_with_tracing_disabled_isolated_to_block() -> None:
    assert gravel_context_singleton.is_tracing_disabled() is False
    with with_tracing_disabled():
        assert gravel_context_singleton.is_tracing_disabled() is True
    assert gravel_context_singleton.is_tracing_disabled() is False


def test_gravel_context_manager_yields_singleton() -> None:
    with gravel_context({"x": 1}) as ctx:
        assert ctx.get_metadata() == {"x": 1}


@pytest.mark.asyncio
async def test_awith_gravel_metadata_async_helper() -> None:
    async def call() -> dict:
        return gravel_context_singleton.get_metadata()

    result = await awith_gravel_metadata({"k": "v"}, call)
    assert result == {"k": "v"}


@pytest.mark.asyncio
async def test_awith_tracing_disabled_async_helper() -> None:
    async with awith_tracing_disabled():
        assert gravel_context_singleton.is_tracing_disabled() is True
    assert gravel_context_singleton.is_tracing_disabled() is False


# ---------- persistence ----------


def test_persist_trace_drops_silently_without_config() -> None:
    """Until set_gravel_tracing_config is called, persist_trace returns None
    instead of raising."""
    set_gravel_tracing_config(None)
    record = make_record(
        name="t",
        started_at=now_utc(),
        completed_at=now_utc() + timedelta(milliseconds=5),
        model="m",
        status="ok",
        input_data={"messages": []},
    )
    assert persist_trace(record) is None


def test_persist_trace_writes_sample_to_sqlite(tmp_path) -> None:
    db_path = tmp_path / "trace.db"
    engine = create_engine(f"sqlite:///{db_path}")
    schema_metadata.create_all(engine)

    set_gravel_tracing_config(
        TracingRuntimeConfig(engine=engine, environment_id="prod")
    )
    try:
        record = make_record(
            name="openai.chat.completions.create",
            started_at=now_utc(),
            completed_at=now_utc() + timedelta(milliseconds=12),
            model="gpt-x",
            status="ok",
            input_data={"messages": [{"role": "user", "content": "hi"}]},
            output_data={"choices": [{"message": {"content": "hello"}}]},
        )
        sample_id = persist_trace(record)
        assert sample_id is not None

        with engine.connect() as conn:
            samples = list(conn.execute(select(gravel_samples)).mappings())

        assert len(samples) == 1
        sample = samples[0]
        assert sample["name"] == "openai.chat.completions.create"
        assert sample["status"] == "completed"
        assert sample["environment"] == "prod"
        assert sample["duration_ms"] >= 0
        assert sample["input"]["messages"][0]["content"] == "hi"
        assert sample["output"]["choices"][0]["message"]["content"] == "hello"
    finally:
        set_gravel_tracing_config(None)


def test_scrub_input_applied(tmp_path) -> None:
    db_path = tmp_path / "scrub.db"
    engine = create_engine(f"sqlite:///{db_path}")
    schema_metadata.create_all(engine)

    def scrub(messages):
        return [{"role": m["role"], "content": "[REDACTED]"} for m in (messages or [])]

    set_gravel_tracing_config(
        TracingRuntimeConfig(engine=engine, environment_id="prod", scrub_input=scrub)
    )
    try:
        record = make_record(
            name="t",
            started_at=now_utc(),
            completed_at=now_utc() + timedelta(milliseconds=1),
            model="m",
            status="ok",
            input_data={"messages": [{"role": "user", "content": "secret"}]},
            output_data={"text": "ok"},
            extra_observations=[
                ObservationRecord(type="state", data={"x": 1}, key="s")
            ],
        )
        persist_trace(record)

        with engine.connect() as conn:
            samples = list(conn.execute(select(gravel_samples)).mappings())
        assert len(samples) == 1
        sample = samples[0]
        assert sample["input"]["messages"][0]["content"] == "[REDACTED]"
        # state observation surfaces in metadata.states.
        assert sample["metadata"]["states"] == [{"key": "s", "data": {"x": 1}}]
    finally:
        set_gravel_tracing_config(None)
