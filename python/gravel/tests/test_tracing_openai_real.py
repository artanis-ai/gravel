"""Real-SDK behavioural tests for the OpenAI auto-patch.

The synthetic `test_tracing_openai.py` injects fake `openai.resources.*`
classes via `sys.modules`. That covers wrapper logic in isolation but
can't catch contract drift in the real SDK (the v0.7.0 Gemini
own-property bug is the canonical example of why we need both).

This file mirrors `test_tracing_anthropic_real.py`: real `openai`
SDK against `httpx.MockTransport`, asserting exactly one row per
call lands under the canonical trace name, no double-record with
the fetch tracer.

Per the audit-seams-not-parts memory: "ground tests in live API
behaviour, not fictional class shapes."
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


def _ensure_real_openai() -> Any:
    """test_tracing_openai.py injects fake `openai.resources.*` into
    sys.modules. Force-re-import the real openai + reinstall the
    patch against it. Mirrors the anthropic _ensure_real_*."""
    for mod in list(sys.modules):
        if mod == "openai" or mod.startswith("openai."):
            del sys.modules[mod]
    sys.modules.pop("artanis_gravel.tracing.openai_patch", None)
    real_openai = pytest.importorskip("openai")
    openai_patch = importlib.import_module("artanis_gravel.tracing.openai_patch")
    openai_patch._PATCHED = False  # type: ignore[attr-defined]
    openai_patch.install()
    return real_openai


@pytest.fixture(autouse=True)
def _reset_openai_for_each_test() -> Iterator[Any]:
    real = _ensure_real_openai()
    global openai
    openai = real
    yield real


openai = pytest.importorskip("openai")
from artanis_gravel.tracing import install_auto_tracing  # noqa: E402


_FAKE_CHAT_RESPONSE: dict[str, Any] = {
    "id": "chatcmpl-test",
    "object": "chat.completion",
    "created": 1234567890,
    "model": "gpt-4o",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "hello"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6},
}

_FAKE_EMBED_RESPONSE: dict[str, Any] = {
    "object": "list",
    "data": [
        {
            "object": "embedding",
            "index": 0,
            "embedding": [0.1, 0.2, 0.3],
        }
    ],
    "model": "text-embedding-3-small",
    "usage": {"prompt_tokens": 3, "total_tokens": 3},
}


@pytest.fixture
def engine_with_tracing(tmp_path) -> Iterator[Engine]:
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
def mock_openai_client(monkeypatch) -> openai.OpenAI:
    """Real `openai.OpenAI()` whose HTTP transport returns a canned
    response per request path. Single endpoint match is enough for
    these tests (chat vs embeddings detected by URL suffix)."""
    def fake_handle(self, request):
        url = str(request.url)
        if "/embeddings" in url:
            body = _FAKE_EMBED_RESPONSE
        else:
            body = _FAKE_CHAT_RESPONSE
        return httpx.Response(
            200,
            json=body,
            request=request,
            headers={"content-type": "application/json"},
        )

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle)
    return openai.OpenAI(api_key="sk-test")


def _persisted_rows(engine: Engine) -> list[tuple[str, str]]:
    import time

    time.sleep(0.4)
    with engine.connect() as conn:
        return [
            (row[0], row[1])
            for row in conn.execute(
                text("select name, status from gravel_samples order by started_at")
            ).fetchall()
        ]


def test_chat_completions_create_records_exactly_one_row(
    engine_with_tracing: Engine, mock_openai_client: openai.OpenAI
) -> None:
    """Single chat.completions.create call: one row, no fetch leak."""
    resp = mock_openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert resp.choices[0].message.content == "hello"
    rows = _persisted_rows(engine_with_tracing)
    assert rows == [("openai.chat.completions.create", "completed")], (
        f"expected exactly one chat.completions row, got: {rows}"
    )


def test_embeddings_create_records_exactly_one_row(
    engine_with_tracing: Engine, mock_openai_client: openai.OpenAI
) -> None:
    """Embeddings calls land under the embeddings trace name."""
    resp = mock_openai_client.embeddings.create(
        model="text-embedding-3-small",
        input="hello world",
    )
    assert len(resp.data[0].embedding) == 3
    rows = _persisted_rows(engine_with_tracing)
    assert rows == [("openai.embeddings.create", "completed")], (
        f"expected exactly one embeddings row, got: {rows}"
    )


def test_sequential_chat_and_embeddings_dont_double_record(
    engine_with_tracing: Engine, mock_openai_client: openai.OpenAI
) -> None:
    """Cross-method canary that fetch_tracing_disabled isn't leaking
    between calls or between method patches."""
    mock_openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "hi"}],
    )
    mock_openai_client.embeddings.create(
        model="text-embedding-3-small",
        input="vectorise me",
    )
    rows = _persisted_rows(engine_with_tracing)
    names = [r[0] for r in rows]
    assert names.count("openai.chat.completions.create") == 1
    assert names.count("openai.embeddings.create") == 1
    assert "fetch:openai.chat.completions" not in names, (
        f"fetch_tracing_disabled regression: fetch row leaked: {rows}"
    )
    assert "fetch:openai.embeddings" not in names, (
        f"fetch_tracing_disabled regression: fetch row leaked: {rows}"
    )
