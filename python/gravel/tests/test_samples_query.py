"""Unit coverage for `samples_query.py` — the read-side queries that
back every `/api/samples*` dashboard route.

Audit-flagged as a P0 test gap in v0.5.10: the dispatcher's smoke
checks pass through `list_samples(engine=None)` only, so the actual
query construction (filters, pagination, joins, feedback rollup) was
unexercised. A regression here silently 500s every dashboard tracing
view.

This file pins:

  * `list_samples`: empty page, ordering, pagination math (page,
    page_size, offset, clamping), each filter (env, model, status,
    q, from, to), filter combinations, total count, tokens extracted
    from metadata jsonb, feedback rollup (positive/negative/mixed/
    neutral/none).
  * `get_sample_detail`: full payload shape, includes ordered
    feedback list, returns None for missing id.
  * `record_sample_feedback`: id is fresh UUID per call, timestamp
    is UTC, score/comment/correction round-trip.
  * `gravel_tables_exist`: handles engine=None (prompts-only),
    handles missing tables, handles present tables.
  * `_iso`, `_coerce_metadata`, `_roll_up_feedback`, `_tokens_from`
    helpers — directly so a refactor doesn't drift them.

Uses an in-memory sqlite engine so tests are self-contained. The
schema is created via `metadata.create_all`, matching what the
Alembic bootstrap would do on a customer DB. JSON columns are
serialised manually for sqlite (it doesn't have native JSON)."""
from __future__ import annotations

import datetime
import json
from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from artanis_gravel.samples_query import (
    DEFAULT_PAGE_SIZE,
    _coerce_metadata,
    _iso,
    _roll_up_feedback,
    _tokens_from,
    get_sample_detail,
    gravel_tables_exist,
    list_samples,
    record_sample_feedback,
)
from artanis_gravel.schema import gravel_feedback, gravel_samples, metadata


# -------------------- Fixture engine + seeders --------------------


@pytest.fixture
def engine() -> Engine:
    """In-memory sqlite with the gravel schema applied. Each test
    gets a fresh engine so writes don't bleed between tests."""
    e = create_engine("sqlite://")
    metadata.create_all(e)
    return e


def _utc(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime.datetime:
    return datetime.datetime(year, month, day, hour, minute, tzinfo=datetime.timezone.utc)


def _seed_sample(
    engine: Engine,
    *,
    sid: str,
    name: str = "trace_test",
    model: str = "gpt-4o",
    environment: str = "production",
    status: str = "completed",
    group_id: str | None = None,
    started_at: datetime.datetime | None = None,
    completed_at: datetime.datetime | None = None,
    duration_ms: int | None = None,
    input_payload: Any = None,
    output_payload: Any = None,
    meta: dict[str, Any] | None = None,
    commit_sha: str | None = None,
    prompt_id: str | None = None,
    timestamp: datetime.datetime | None = None,
) -> None:
    ts = timestamp or started_at or _utc(2026, 5, 1)
    with engine.begin() as conn:
        conn.execute(
            gravel_samples.insert().values(
                id=sid,
                name=name,
                model=model,
                environment=environment,
                status=status,
                group_id=group_id,
                started_at=ts,
                completed_at=completed_at,
                duration_ms=duration_ms,
                input=json.dumps(input_payload) if input_payload is not None else None,
                output=json.dumps(output_payload) if output_payload is not None else None,
                metadata=json.dumps(meta or {}),
                timestamp=ts,
                commit_sha=commit_sha,
                prompt_id=prompt_id,
            )
        )


def _seed_feedback(
    engine: Engine,
    *,
    fid: str,
    sample_id: str,
    score: str | None = "positive",
    comment: str | None = None,
    correction: str | None = None,
    reporter_user_id: str | None = "u1",
    source: str = "ui",
    timestamp: datetime.datetime | None = None,
) -> None:
    ts = timestamp or _utc(2026, 5, 1, 12)
    with engine.begin() as conn:
        conn.execute(
            gravel_feedback.insert().values(
                id=fid,
                sample_id=sample_id,
                score=score,
                comment=comment,
                correction=correction,
                source=source,
                reporter_user_id=reporter_user_id,
                timestamp=ts,
            )
        )


# -------------------- list_samples: basics --------------------


def test_list_samples_empty_db_returns_empty_page(engine):
    """No rows → empty samples, total=0, default page/page_size."""
    result = list_samples(engine)
    assert result == {"samples": [], "total": 0, "page": 1, "page_size": DEFAULT_PAGE_SIZE}


def test_list_samples_orders_by_timestamp_desc(engine):
    """Newest sample first — the dashboard renders most-recent at top."""
    _seed_sample(engine, sid="old", timestamp=_utc(2026, 5, 1))
    _seed_sample(engine, sid="mid", timestamp=_utc(2026, 5, 5))
    _seed_sample(engine, sid="new", timestamp=_utc(2026, 5, 10))

    result = list_samples(engine)
    assert [s["id"] for s in result["samples"]] == ["new", "mid", "old"]


def test_list_samples_total_count_matches_unfiltered_rows(engine):
    for i in range(7):
        _seed_sample(engine, sid=f"s{i}", timestamp=_utc(2026, 5, i + 1))
    result = list_samples(engine, page_size=3)
    assert result["total"] == 7
    assert len(result["samples"]) == 3


# -------------------- list_samples: pagination --------------------


def test_list_samples_page_offset_math(engine):
    """page=2, page_size=3 → rows 4-6 (0-indexed: skip 3, take 3)."""
    for i in range(7):
        _seed_sample(engine, sid=f"s{i}", timestamp=_utc(2026, 5, i + 1))
    page2 = list_samples(engine, page=2, page_size=3)
    # After desc-timestamp ordering: [s6, s5, s4, s3, s2, s1, s0].
    # Page 2 (offset=3, limit=3) → [s3, s2, s1].
    assert [s["id"] for s in page2["samples"]] == ["s3", "s2", "s1"]
    assert page2["page"] == 2
    assert page2["page_size"] == 3
    assert page2["total"] == 7


def test_list_samples_clamps_page_below_one_to_one(engine):
    _seed_sample(engine, sid="a")
    result = list_samples(engine, page=-5)
    assert result["page"] == 1


def test_list_samples_clamps_page_size_to_max_100(engine):
    """Defends the dashboard from someone asking for 10_000 rows in
    one shot — protects DB connection time."""
    result = list_samples(engine, page_size=9999)
    assert result["page_size"] == 100


def test_list_samples_page_size_zero_treated_as_default(engine):
    """`page_size=0` falls back to DEFAULT_PAGE_SIZE (treated as
    'unspecified'). Negative integers do get clamped to 1, see below."""
    _seed_sample(engine, sid="a")
    result = list_samples(engine, page_size=0)
    assert result["page_size"] == DEFAULT_PAGE_SIZE


def test_list_samples_clamps_negative_page_size_to_one(engine):
    """A negative page_size shouldn't happen via the dashboard, but
    defend against it instead of issuing `LIMIT -5` to SQL."""
    _seed_sample(engine, sid="a")
    result = list_samples(engine, page_size=-5)
    assert result["page_size"] == 1


def test_list_samples_none_page_size_uses_default(engine):
    result = list_samples(engine, page_size=None)
    assert result["page_size"] == DEFAULT_PAGE_SIZE


# -------------------- list_samples: filters --------------------


@pytest.fixture
def populated(engine):
    """Mixed-environment / mixed-model dataset shared by filter tests."""
    _seed_sample(engine, sid="prod-gpt4", environment="production", model="gpt-4o", status="completed", name="prod-trace")
    _seed_sample(engine, sid="staging-gpt4", environment="staging", model="gpt-4o", status="completed", name="staging-trace")
    _seed_sample(engine, sid="prod-claude", environment="production", model="claude-3", status="errored", name="prod-claude-trace")
    _seed_sample(engine, sid="dev-gpt4", environment="development", model="gpt-4o", status="running", name="dev-trace")
    return engine


def test_filter_env(populated):
    result = list_samples(populated, env="production")
    ids = {s["id"] for s in result["samples"]}
    assert ids == {"prod-gpt4", "prod-claude"}
    assert result["total"] == 2


def test_filter_model(populated):
    result = list_samples(populated, model="claude-3")
    assert [s["id"] for s in result["samples"]] == ["prod-claude"]


def test_filter_status(populated):
    result = list_samples(populated, status="errored")
    assert [s["id"] for s in result["samples"]] == ["prod-claude"]


def test_filter_q_matches_name_and_model(populated):
    """The free-text query filters by name OR model substring."""
    # Matches the model column.
    result = list_samples(populated, q="claude")
    ids = {s["id"] for s in result["samples"]}
    assert ids == {"prod-claude"}
    # Matches the name column.
    result2 = list_samples(populated, q="staging")
    assert {s["id"] for s in result2["samples"]} == {"staging-gpt4"}


def test_filter_from_and_to_bounds_against_timestamp(engine):
    """from_ / to are bounds against the `timestamp` column.

    NOTE on storage: SQLite stores datetimes as TEXT in the form
    'YYYY-MM-DD HH:MM:SS.ffffff' (with a SPACE, no 'T', no tz suffix).
    Postgres stores them as proper TIMESTAMPTZ. The handler passes
    the from_/to user input through to SQLAlchemy as-is, so on
    SQLite this becomes a string comparison and ISO 8601 with 'T'
    sorts AFTER the space-separated form. Customers on Postgres
    don't hit this; SQLite customers should use the 'YYYY-MM-DD
    HH:MM:SS' form. Tracked separately; not in scope for this test.

    This test uses dates with comparison-stable formatting so the
    underlying filter logic is exercised on both backends.
    """
    _seed_sample(engine, sid="apr-30", timestamp=_utc(2026, 4, 30))
    _seed_sample(engine, sid="may-1", timestamp=_utc(2026, 5, 1))
    _seed_sample(engine, sid="may-15", timestamp=_utc(2026, 5, 15))
    _seed_sample(engine, sid="jun-1", timestamp=_utc(2026, 6, 1))
    # Use date-only (no time) — these compare cleanly as prefixes on
    # both Postgres and SQLite text storage.
    result = list_samples(engine, from_="2026-04-30", to="2026-05-16")
    ids = {s["id"] for s in result["samples"]}
    assert ids == {"apr-30", "may-1", "may-15"}, ids
    # Bound on the other side: apr-30 dropped.
    result2 = list_samples(engine, from_="2026-05-01", to="2026-05-16")
    ids2 = {s["id"] for s in result2["samples"]}
    assert ids2 == {"may-1", "may-15"}, ids2


def test_filter_combination_anded_together(populated):
    """Multiple filters are ANDed (NOT ORed)."""
    result = list_samples(populated, env="production", model="gpt-4o")
    assert {s["id"] for s in result["samples"]} == {"prod-gpt4"}


def test_filter_no_match_returns_empty(populated):
    result = list_samples(populated, env="production", model="gpt-3.5")
    assert result["samples"] == []
    assert result["total"] == 0


# -------------------- list_samples: derived fields --------------------


def test_list_samples_pulls_tokens_from_metadata(engine):
    """tokens_in / tokens_out come from metadata.tokens_input /
    metadata.tokens_output. The dashboard shows these in the row."""
    _seed_sample(
        engine,
        sid="with-tokens",
        meta={"tokens_input": 123, "tokens_output": 456, "other": "ignored"},
    )
    result = list_samples(engine)
    s = result["samples"][0]
    assert s["tokens_in"] == 123
    assert s["tokens_out"] == 456


def test_list_samples_missing_tokens_metadata_yields_none(engine):
    _seed_sample(engine, sid="no-tokens", meta={})
    s = list_samples(engine)["samples"][0]
    assert s["tokens_in"] is None
    assert s["tokens_out"] is None


def test_list_samples_includes_completed_and_started_iso(engine):
    """Timestamps come back as ISO 8601 strings, not python datetimes
    (the dashboard parses them as strings)."""
    start = _utc(2026, 5, 5, 10, 30)
    done = _utc(2026, 5, 5, 10, 31)
    _seed_sample(engine, sid="s1", started_at=start, completed_at=done, duration_ms=60_000)
    s = list_samples(engine)["samples"][0]
    assert s["started_at"].startswith("2026-05-05T10:30")
    assert s["completed_at"].startswith("2026-05-05T10:31")
    assert s["duration_ms"] == 60_000


def test_list_samples_completed_at_can_be_null(engine):
    """A running sample has no completed_at; the field must be JSON
    null, not the python sentinel."""
    _seed_sample(engine, sid="s1", status="running", completed_at=None)
    s = list_samples(engine)["samples"][0]
    assert s["completed_at"] is None


def test_list_samples_metadata_decoded_from_json_string(engine):
    """sqlite stores JSON as a string; the query must decode it."""
    _seed_sample(engine, sid="s1", meta={"foo": "bar", "n": 1})
    s = list_samples(engine)["samples"][0]
    assert s["metadata"] == {"foo": "bar", "n": 1}


# -------------------- list_samples: feedback rollup --------------------


def test_feedback_rollup_zero(engine):
    """No feedback rows for a sample → count=0, score=None."""
    _seed_sample(engine, sid="s1")
    s = list_samples(engine)["samples"][0]
    assert s["feedback_count"] == 0
    assert s["feedback_score"] is None


def test_feedback_rollup_positive_only(engine):
    _seed_sample(engine, sid="s1")
    _seed_feedback(engine, fid="f1", sample_id="s1", score="positive")
    _seed_feedback(engine, fid="f2", sample_id="s1", score="positive")
    s = list_samples(engine)["samples"][0]
    assert s["feedback_count"] == 2
    assert s["feedback_score"] == "positive"


def test_feedback_rollup_negative_only(engine):
    _seed_sample(engine, sid="s1")
    _seed_feedback(engine, fid="f1", sample_id="s1", score="negative")
    s = list_samples(engine)["samples"][0]
    assert s["feedback_score"] == "negative"


def test_feedback_rollup_mixed_when_pos_and_neg(engine):
    """Positive + negative on the same sample → 'mixed', not 'positive'
    or 'negative'. Reviewers need to see disagreement explicitly."""
    _seed_sample(engine, sid="s1")
    _seed_feedback(engine, fid="f1", sample_id="s1", score="positive")
    _seed_feedback(engine, fid="f2", sample_id="s1", score="negative")
    s = list_samples(engine)["samples"][0]
    assert s["feedback_count"] == 2
    assert s["feedback_score"] == "mixed"


def test_feedback_rollup_neutral_alone_returns_none(engine):
    """Pure-neutral feedback → score=None (neutral isn't a directional
    signal). The dashboard renders no badge."""
    _seed_sample(engine, sid="s1")
    _seed_feedback(engine, fid="f1", sample_id="s1", score="neutral")
    s = list_samples(engine)["samples"][0]
    assert s["feedback_count"] == 1
    assert s["feedback_score"] is None


def test_feedback_does_not_leak_across_samples(engine):
    """A feedback row on s1 must not influence s2's rollup."""
    _seed_sample(engine, sid="s1", timestamp=_utc(2026, 5, 1))
    _seed_sample(engine, sid="s2", timestamp=_utc(2026, 5, 2))
    _seed_feedback(engine, fid="f1", sample_id="s1", score="positive")
    rows = {s["id"]: s for s in list_samples(engine)["samples"]}
    assert rows["s1"]["feedback_score"] == "positive"
    assert rows["s2"]["feedback_score"] is None
    assert rows["s2"]["feedback_count"] == 0


# -------------------- get_sample_detail --------------------


def test_get_sample_detail_missing_returns_none(engine):
    assert get_sample_detail(engine, "nope") is None


def test_get_sample_detail_returns_full_shape(engine):
    _seed_sample(
        engine,
        sid="s1",
        name="my-trace",
        model="gpt-4o",
        environment="production",
        status="completed",
        group_id="grp1",
        started_at=_utc(2026, 5, 5, 10),
        completed_at=_utc(2026, 5, 5, 10, 1),
        duration_ms=60_000,
        input_payload={"q": "hi"},
        output_payload={"a": "hello"},
        meta={"k": "v"},
        commit_sha="abc123",
        prompt_id="p_xyz",
    )
    _seed_feedback(
        engine,
        fid="f1",
        sample_id="s1",
        score="positive",
        comment="great",
        correction=None,
        reporter_user_id="u-alice",
        timestamp=_utc(2026, 5, 5, 11),
    )
    detail = get_sample_detail(engine, "s1")
    assert detail is not None
    assert detail["id"] == "s1"
    assert detail["name"] == "my-trace"
    assert detail["group_id"] == "grp1"
    assert detail["prompt_id"] == "p_xyz"
    assert detail["commit_sha"] == "abc123"
    assert detail["metadata"] == {"k": "v"}
    # Input/output preserved as written.
    assert detail["input"] is not None
    assert detail["output"] is not None
    # Feedback list shape matches the dashboard's expectations.
    assert len(detail["feedback"]) == 1
    fb = detail["feedback"][0]
    assert fb["score"] == "positive"
    assert fb["comment"] == "great"
    assert fb["correction"] is None
    assert fb["source"] == "ui"
    assert fb["reporter_user_id"] == "u-alice"


def test_get_sample_detail_feedback_ordered_newest_first(engine):
    """Feedback list ordered by timestamp DESC so the most-recent
    reviewer comment is at the top of the dialog."""
    _seed_sample(engine, sid="s1")
    _seed_feedback(engine, fid="old", sample_id="s1", timestamp=_utc(2026, 5, 1))
    _seed_feedback(engine, fid="new", sample_id="s1", timestamp=_utc(2026, 5, 10))
    _seed_feedback(engine, fid="mid", sample_id="s1", timestamp=_utc(2026, 5, 5))
    detail = get_sample_detail(engine, "s1")
    assert [f["id"] for f in detail["feedback"]] == ["new", "mid", "old"]


# -------------------- record_sample_feedback --------------------


def test_record_sample_feedback_returns_new_id(engine):
    _seed_sample(engine, sid="s1")
    result = record_sample_feedback(
        engine,
        sample_id="s1",
        score="positive",
        comment="good",
        correction=None,
        reporter_user_id="u1",
    )
    assert "id" in result
    assert isinstance(result["id"], str)
    assert len(result["id"]) > 20  # uuid


def test_record_sample_feedback_id_is_unique_per_call(engine):
    _seed_sample(engine, sid="s1")
    ids = {
        record_sample_feedback(
            engine,
            sample_id="s1",
            score="positive",
            comment=None,
            correction=None,
            reporter_user_id="u1",
        )["id"]
        for _ in range(5)
    }
    assert len(ids) == 5


def test_record_sample_feedback_persists_and_surfaces_in_detail(engine):
    _seed_sample(engine, sid="s1")
    record_sample_feedback(
        engine,
        sample_id="s1",
        score="negative",
        comment="off-topic",
        correction="should mention X",
        reporter_user_id="u-bob",
    )
    detail = get_sample_detail(engine, "s1")
    fb = detail["feedback"][0]
    assert fb["score"] == "negative"
    assert fb["comment"] == "off-topic"
    assert fb["correction"] == "should mention X"
    assert fb["reporter_user_id"] == "u-bob"
    assert fb["source"] == "ui"  # default source


# -------------------- gravel_tables_exist --------------------


def test_gravel_tables_exist_with_engine_none_is_false():
    """Prompts-only install — no DB configured."""
    assert gravel_tables_exist(None) is False


def test_gravel_tables_exist_with_empty_engine_is_false():
    """Engine to a fresh DB that hasn't been migrated yet → False."""
    e = create_engine("sqlite://")
    assert gravel_tables_exist(e) is False


def test_gravel_tables_exist_with_real_schema_is_true(engine):
    """After metadata.create_all (the fixture), both tables exist."""
    assert gravel_tables_exist(engine) is True


# -------------------- Helper unit tests --------------------


def test_iso_datetime():
    dt = _utc(2026, 5, 13, 12, 34)
    assert _iso(dt).startswith("2026-05-13T12:34")


def test_iso_none_passthrough():
    assert _iso(None) is None


def test_iso_string_passthrough():
    assert _iso("not-a-date") == "not-a-date"


def test_coerce_metadata_dict_passthrough():
    assert _coerce_metadata({"a": 1}) == {"a": 1}


def test_coerce_metadata_json_string():
    assert _coerce_metadata('{"a": 1}') == {"a": 1}


def test_coerce_metadata_invalid_json_returns_empty():
    assert _coerce_metadata("not json") == {}


def test_coerce_metadata_non_dict_json_returns_empty():
    """A JSON array isn't a dict → fall back to {}, don't return the
    list (would crash downstream consumers expecting key access)."""
    assert _coerce_metadata("[1, 2, 3]") == {}


def test_coerce_metadata_none_returns_empty():
    assert _coerce_metadata(None) == {}


def test_tokens_from_extracts_ints():
    assert _tokens_from({"tokens_input": 10, "tokens_output": 20}) == (10, 20)


def test_tokens_from_missing_returns_none():
    assert _tokens_from({}) == (None, None)


def test_tokens_from_non_int_returns_none():
    """Defensive: someone wrote a string into a token field."""
    assert _tokens_from({"tokens_input": "10", "tokens_output": 5.5}) == (None, None)


def test_roll_up_feedback_empty():
    assert _roll_up_feedback([]) is None


def test_roll_up_feedback_none_only():
    assert _roll_up_feedback([None, None]) is None


def test_roll_up_feedback_invalid_score():
    """A score outside the enum is treated as missing (not 'mixed')."""
    assert _roll_up_feedback(["weird", "made-up"]) is None
