"""Real-SDK behavioural tests for the anthropic patches.

The existing test_tracing_anthropic.py uses a synthetic
`anthropic.resources.messages.Messages` injected via sys.modules.
That validates the wrapper's logic in isolation but doesn't catch
real-world drift — Claude's de_platform install (2026-05-20) saw
`messages.parse()` going un-patched + claimed `messages.create()`
was double-recording in production. Synthetic tests can't catch
either class.

This file exercises the actual `anthropic` SDK against an
httpx.MockTransport, asserting EXACTLY one row per call lands in
gravel_samples for each method we patch. Per the
audit-seams-not-parts memory: "ground tests in live API behaviour,
not fictional class shapes."
"""
from __future__ import annotations

import importlib
import sys
from typing import Any, Iterator

import httpx
import pytest
from sqlalchemy import Engine, create_engine, text

from artanis_gravel.db.bootstrap import bootstrap
from artanis_gravel.tracing.persist import (
    TracingRuntimeConfig,
    set_gravel_tracing_config,
)


def _ensure_real_anthropic() -> Any:
    """test_tracing_anthropic.py injects a fake `anthropic` into
    sys.modules and may leave residue if reordered. To make these
    real-SDK tests robust to test ordering, force a fresh import of
    the real anthropic + reinstall our patch against it."""
    for mod in list(sys.modules):
        if mod == "anthropic" or mod.startswith("anthropic."):
            del sys.modules[mod]
    sys.modules.pop("artanis_gravel.tracing.anthropic_patch", None)
    real_anthropic = pytest.importorskip("anthropic")
    anthropic_patch = importlib.import_module("artanis_gravel.tracing.anthropic_patch")
    anthropic_patch._PATCHED = False  # type: ignore[attr-defined]
    anthropic_patch.install()
    return real_anthropic


@pytest.fixture(autouse=True)
def _reset_anthropic_for_each_test() -> Iterator[Any]:
    """Autouse: every test in this file gets a clean real-anthropic
    + freshly-installed patch."""
    real = _ensure_real_anthropic()
    # Also reset module-level alias so the rest of the file picks it up.
    global anthropic
    anthropic = real
    yield real


anthropic = pytest.importorskip("anthropic")
from artanis_gravel.tracing import install_auto_tracing  # noqa: E402


_FAKE_RESPONSE: dict[str, Any] = {
    "id": "msg_test",
    "type": "message",
    "role": "assistant",
    "content": [{"type": "text", "text": "hello"}],
    "model": "claude-sonnet-4-5",
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 5, "output_tokens": 5},
}


@pytest.fixture
def engine_with_tracing(tmp_path) -> Iterator[Engine]:
    """An in-memory(-on-disk) sqlite + persister set up so traces
    land somewhere we can inspect."""
    db_path = tmp_path / "trace_test.db"
    engine = create_engine(f"sqlite:///{db_path}")
    bootstrap(engine)
    set_gravel_tracing_config(
        TracingRuntimeConfig(engine=engine, environment_id="test")
    )
    install_auto_tracing(engine)
    yield engine
    set_gravel_tracing_config(None)


@pytest.fixture
def mock_anthropic_client(monkeypatch) -> anthropic.Anthropic:
    """Anthropic client whose HTTPTransport returns _FAKE_RESPONSE for
    every request. Using monkeypatch.setattr at the class level so
    every Client instance (including the one anthropic creates by
    default) picks it up."""
    def fake_handle(self, request):
        return httpx.Response(
            200,
            json=_FAKE_RESPONSE,
            request=request,
            headers={"content-type": "application/json"},
        )

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle)
    return anthropic.Anthropic(api_key="sk-test")


def _persisted_rows(engine: Engine) -> list[tuple[str, str]]:
    """Wait briefly for the async persister to flush, then return
    [(name, status), ...] in started_at order."""
    import time

    time.sleep(0.4)
    with engine.connect() as conn:
        return [
            (row[0], row[1])
            for row in conn.execute(
                text("select name, status from gravel_samples order by started_at")
            ).fetchall()
        ]


def test_messages_create_records_exactly_one_row(
    engine_with_tracing: Engine, mock_anthropic_client: anthropic.Anthropic
) -> None:
    """Single .create call → ONE row under `anthropic.messages.create`.

    Pre-v0.9.1 Claude reported seeing TWO rows (the SDK row + a fetch
    row). Our internal repro can't get to two; the suppression IS
    working in v0.8.x source. This test is the canary so the
    suppression can't break silently in any future SDK rev."""
    resp = mock_anthropic_client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=10,
        messages=[{"role": "user", "content": "hi"}],
    )
    assert resp.content[0].text == "hello"
    rows = _persisted_rows(engine_with_tracing)
    assert rows == [("anthropic.messages.create", "completed")], (
        f"expected exactly one anthropic.messages.create row, got: {rows}"
    )


def test_messages_parse_records_exactly_one_row(
    engine_with_tracing: Engine, mock_anthropic_client: anthropic.Anthropic
) -> None:
    """`.parse()` (structured output) records as
    `anthropic.messages.parse`. Pre-v0.9.1 this was un-patched and
    only the generic `fetch:anthropic.messages` row landed with no
    input richness. Claude's de_platform install caught it."""
    from pydantic import BaseModel

    class Answer(BaseModel):
        answer: str

    # We don't care if the response actually parses — we only care
    # what gets persisted. parse() raises if the response can't be
    # coerced; catch & continue so we still inspect rows.
    try:
        mock_anthropic_client.messages.parse(
            model="claude-sonnet-4-5",
            max_tokens=10,
            messages=[{"role": "user", "content": "give me JSON"}],
            output_format=Answer,
        )
    except Exception:
        # parse() may raise on the mock's non-JSON content; the trace
        # records regardless (status="errored").
        pass

    rows = _persisted_rows(engine_with_tracing)
    assert len(rows) == 1, f"expected exactly one row from parse(), got: {rows}"
    assert rows[0][0] == "anthropic.messages.parse"


def test_create_and_parse_dont_double_record(
    engine_with_tracing: Engine, mock_anthropic_client: anthropic.Anthropic
) -> None:
    """Sequential .create + .parse → exactly two rows, one each.
    Cross-method canary that fetch_tracing_disabled isn't leaking
    between calls."""
    mock_anthropic_client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=10,
        messages=[{"role": "user", "content": "hi"}],
    )
    try:
        from pydantic import BaseModel

        class Answer(BaseModel):
            answer: str

        mock_anthropic_client.messages.parse(
            model="claude-sonnet-4-5",
            max_tokens=10,
            messages=[{"role": "user", "content": "json"}],
            output_format=Answer,
        )
    except Exception:
        pass

    rows = _persisted_rows(engine_with_tracing)
    names = [r[0] for r in rows]
    assert names.count("anthropic.messages.create") == 1
    assert names.count("anthropic.messages.parse") == 1
    # And no spurious fetch rows from either call.
    assert "fetch:anthropic.messages" not in names, (
        f"fetch_tracing_disabled regression — fetch row leaked: {rows}"
    )
