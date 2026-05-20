"""Real-SDK behavioural tests for the Gemini auto-patch.

The synthetic `test_tracing_gemini.py` injects a fake
`google.genai.models.Models` class via sys.modules. That covers
wrapper logic but can't catch contract drift in the real SDK (the
TS-side v0.7.0 own-property bug is the canonical example of why we
need both — same SDK family).

Real `google.genai.Client()` against `httpx.MockTransport`. Mirrors
`test_tracing_anthropic_real.py` and `test_tracing_openai_real.py`.
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


def _ensure_real_genai() -> Any:
    """test_tracing_gemini.py injects fakes via sys.modules. Force
    re-import the real SDK + reinstall the patch."""
    for mod in list(sys.modules):
        if mod == "google" or mod.startswith("google."):
            del sys.modules[mod]
    sys.modules.pop("artanis_gravel.tracing.gemini_patch", None)
    real_genai = pytest.importorskip("google.genai")
    gemini_patch = importlib.import_module("artanis_gravel.tracing.gemini_patch")
    gemini_patch._PATCHED = False  # type: ignore[attr-defined]
    gemini_patch.install()
    return real_genai


@pytest.fixture(autouse=True)
def _reset_genai_for_each_test() -> Iterator[Any]:
    real = _ensure_real_genai()
    global genai
    genai = real
    yield real


genai = pytest.importorskip("google.genai")
from artanis_gravel.tracing import install_auto_tracing  # noqa: E402


# Realistic shape captured from gemini-flash-latest 2026-05-19, matched
# against what the TS-side `tracing-gemini-integration.test.ts` mocks.
_FAKE_GENAI_RESPONSE: dict[str, Any] = {
    "candidates": [
        {
            "content": {
                "parts": [{"text": "mock-gemini-response", "thoughtSignature": "AAAA"}],
                "role": "model",
            },
            "finishReason": "STOP",
            "index": 0,
        }
    ],
    "usageMetadata": {
        "promptTokenCount": 8,
        "candidatesTokenCount": 4,
        "totalTokenCount": 60,
        "thoughtsTokenCount": 48,
    },
    "modelVersion": "gemini-mock",
    "responseId": "mock-001",
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
def mock_genai_client(monkeypatch) -> Any:
    """Real `genai.Client()` whose httpx transport returns the canned
    Gemini response. Same monkeypatch trick as anthropic_real /
    openai_real."""
    def fake_handle(self, request):
        return httpx.Response(
            200,
            json=_FAKE_GENAI_RESPONSE,
            request=request,
            headers={"content-type": "application/json"},
        )

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle)
    return genai.Client(api_key="test-key")


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


def test_generate_content_records_exactly_one_row(
    engine_with_tracing: Engine, mock_genai_client: Any
) -> None:
    """Single .generate_content call: one row, no fetch leak."""
    resp = mock_genai_client.models.generate_content(
        model="gemini-mock-test",
        contents=[{"role": "user", "parts": [{"text": "hello"}]}],
    )
    assert resp.candidates[0].content.parts[0].text == "mock-gemini-response"

    rows = _persisted_rows(engine_with_tracing)
    assert rows == [("gemini.models.generate_content", "completed")], (
        f"expected exactly one generate_content row, got: {rows}"
    )


def test_sequential_calls_dont_double_record(
    engine_with_tracing: Engine, mock_genai_client: Any
) -> None:
    """Two .generate_content calls: exactly two rows, no fetch leaks.
    Cross-call canary that suppression resets cleanly between calls."""
    for _ in range(2):
        mock_genai_client.models.generate_content(
            model="gemini-mock-test",
            contents=[{"role": "user", "parts": [{"text": "hi"}]}],
        )

    rows = _persisted_rows(engine_with_tracing)
    names = [r[0] for r in rows]
    assert names.count("gemini.models.generate_content") == 2, (
        f"expected exactly two generate_content rows: {rows}"
    )
    assert "fetch:gemini.models.generate_content" not in names, (
        f"fetch_tracing_disabled regression: fetch row leaked: {rows}"
    )
