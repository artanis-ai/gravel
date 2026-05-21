"""Unit tests for `artanis_gravel.tracing.gemini_patch`.

The real `google-genai` package isn't installed in CI, so we synthesise a
minimal `google.genai.models.Models` class hierarchy in `sys.modules` before
importing the patch. The patch wraps those synthesised classes; we exercise
them like the user would.

Mirrors the openai_patch / anthropic_patch test patterns.
"""
from __future__ import annotations

import importlib
import sys
import types
from typing import Any
from unittest.mock import MagicMock

import pytest


def _build_fake_google_genai() -> None:
    pkg_google = types.ModuleType("google")
    pkg_genai = types.ModuleType("google.genai")
    models_mod = types.ModuleType("google.genai.models")

    class Models:
        # Per-test override — same pattern as the openai fake.
        _impl = staticmethod(
            lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no impl"))
        )
        _impl_stream = staticmethod(
            lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no impl_stream"))
        )

        def generate_content(self, **kwargs: Any) -> Any:
            return type(self)._impl(**kwargs)

        def generate_content_stream(self, **kwargs: Any) -> Any:
            return type(self)._impl_stream(**kwargs)

    models_mod.Models = Models  # type: ignore[attr-defined]

    sys.modules["google"] = pkg_google
    sys.modules["google.genai"] = pkg_genai
    sys.modules["google.genai.models"] = models_mod


@pytest.fixture
def gemini_patched(monkeypatch: pytest.MonkeyPatch):
    _build_fake_google_genai()
    sys.modules.pop("artanis_gravel.tracing.gemini_patch", None)
    gemini_patch = importlib.import_module("artanis_gravel.tracing.gemini_patch")

    persist_mock = MagicMock(return_value="trace_id_test")
    monkeypatch.setattr(gemini_patch, "persist_trace", persist_mock)

    from google.genai.models import Models

    yield Models, persist_mock

    gemini_patch.uninstall()
    for mod in list(sys.modules):
        if mod == "google" or mod.startswith("google."):
            del sys.modules[mod]
    sys.modules.pop("artanis_gravel.tracing.gemini_patch", None)


def test_generate_content_persists_trace(gemini_patched) -> None:
    Models, persist_mock = gemini_patched

    fake = {
        "candidates": [
            {
                "content": {"role": "model", "parts": [{"text": "Tokyo."}]},
                "finish_reason": "STOP",
            }
        ],
        "usage_metadata": {
            "prompt_token_count": 12,
            "candidates_token_count": 3,
            "total_token_count": 15,
        },
    }
    Models._impl = staticmethod(lambda **kwargs: fake)

    client = Models()
    result = client.generate_content(
        model="gemini-2.0-flash",
        contents=[{"role": "user", "parts": [{"text": "Capital of Japan?"}]}],
    )
    assert result is fake

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.name == "gemini.models.generate_content"
    assert record.status == "ok"
    assert record.model == "gemini-2.0-flash"
    input_obs = next(o for o in record.observations if o.type == "input")
    assert input_obs.data["contents"][0]["parts"][0]["text"] == "Capital of Japan?"
    output_obs = next(o for o in record.observations if o.type == "output")
    assert output_obs.data["candidates"][0]["content"]["parts"][0]["text"] == "Tokyo."


def test_disabled_via_env_short_circuits(
    monkeypatch: pytest.MonkeyPatch, gemini_patched
) -> None:
    Models, persist_mock = gemini_patched
    monkeypatch.setenv("GRAVEL_TRACING_DISABLED", "1")
    Models._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Models()
    out = client.generate_content(model="gemini-x", contents=[])
    assert out == {"ok": True}
    persist_mock.assert_not_called()


def test_per_call_disable_short_circuits(gemini_patched) -> None:
    from artanis_gravel.tracing import with_tracing_disabled

    Models, persist_mock = gemini_patched
    Models._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Models()
    with with_tracing_disabled():
        client.generate_content(model="gemini-x", contents=[])

    persist_mock.assert_not_called()


def test_sdk_tracing_disabled_short_circuits(gemini_patched) -> None:
    """When the LangChain handler owns the trace it sets sdk_tracing_disabled
    so the inner google-genai call doesn't double-record."""
    from artanis_gravel.tracing import gravel_context_singleton

    Models, persist_mock = gemini_patched
    Models._impl = staticmethod(lambda **kwargs: {"ok": True})

    token = gravel_context_singleton.push_sdk_tracing_disabled()
    try:
        client = Models()
        client.generate_content(model="gemini-x", contents=[])
    finally:
        gravel_context_singleton.pop_sdk_tracing_disabled(token)

    persist_mock.assert_not_called()


def test_error_propagates_and_persists(gemini_patched) -> None:
    Models, persist_mock = gemini_patched

    class Boom(RuntimeError):
        pass

    def raising(**kwargs: Any) -> Any:
        raise Boom("503 model overloaded")

    Models._impl = staticmethod(raising)

    client = Models()
    with pytest.raises(Boom):
        client.generate_content(model="gemini-x", contents=[])

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.status == "errored"
    err_obs = next(o for o in record.observations if o.type == "error")
    assert err_obs.data["type"] == "Boom"
    assert "503 model overloaded" in err_obs.data["message"]


def test_streaming_tees_and_persists_at_close(gemini_patched) -> None:
    Models, persist_mock = gemini_patched

    chunks = [
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "3"}]}}]},
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "\n2"}]}}]},
        {
            "candidates": [
                {
                    "content": {"role": "model", "parts": [{"text": "\n1"}]},
                    "finish_reason": "STOP",
                }
            ]
        },
    ]
    Models._impl_stream = staticmethod(lambda **kwargs: iter(chunks))

    client = Models()
    stream = client.generate_content_stream(
        model="gemini-x",
        contents=[{"role": "user", "parts": [{"text": "Count down."}]}],
    )

    received = list(stream)
    assert received == chunks

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.name == "gemini.models.generate_content_stream"
    assert record.status == "ok"
    output_obs = next(o for o in record.observations if o.type == "output")
    assert len(output_obs.data["chunks"]) == 3
    state_obs = next(o for o in record.observations if o.type == "state")
    assert state_obs.data["chunk_count"] == 3


def test_streaming_error_propagates_and_persists(gemini_patched) -> None:
    Models, persist_mock = gemini_patched

    class Boom(RuntimeError):
        pass

    def gen():
        yield {"candidates": [{"content": {"role": "model", "parts": [{"text": "hel"}]}}]}
        raise Boom("mid-stream")

    Models._impl_stream = staticmethod(lambda **kwargs: gen())

    client = Models()
    stream = client.generate_content_stream(model="gemini-x", contents=[])

    with pytest.raises(Boom):
        list(stream)

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.status == "errored"


def test_metadata_context_flows_into_record(gemini_patched) -> None:
    from artanis_gravel.tracing import with_gravel_metadata

    Models, persist_mock = gemini_patched
    Models._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Models()
    with with_gravel_metadata({"user_id": "u_42"}):
        client.generate_content(model="gemini-x", contents=[])

    record = persist_mock.call_args.args[0]
    assert record.metadata["user_id"] == "u_42"


def test_fetch_tracing_disabled_during_call(gemini_patched) -> None:
    """The Gemini SDK routes through httpx; the patch must mark
    fetch_tracing_disabled during the underlying call so fetch_patch
    doesn't double-record."""
    from artanis_gravel.tracing import gravel_context_singleton

    Models, _persist_mock = gemini_patched
    seen_during_call: list[bool] = []

    def impl(**kwargs: Any) -> Any:
        seen_during_call.append(gravel_context_singleton.is_fetch_tracing_disabled())
        return {"ok": True}

    Models._impl = staticmethod(impl)

    client = Models()
    assert gravel_context_singleton.is_fetch_tracing_disabled() is False
    client.generate_content(model="gemini-x", contents=[])
    assert seen_during_call == [True]
    # Flag is restored after the call.
    assert gravel_context_singleton.is_fetch_tracing_disabled() is False


def test_routing_metadata_vertex(gemini_patched) -> None:
    """When the Models instance carries `_api_client.vertexai=True`, the
    persisted record's metadata records `routing='vertex'`. The dashboard
    uses this to paint a 'via Vertex AI' caption pill."""
    Models, persist_mock = gemini_patched
    Models._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Models()
    client._api_client = types.SimpleNamespace(vertexai=True)
    client.generate_content(model="gemini-x", contents=[])

    record = persist_mock.call_args.args[0]
    assert record.metadata["routing"] == "vertex"


def test_routing_metadata_gemini_api(gemini_patched) -> None:
    """Default Gemini Developer API: `_api_client.vertexai` is False/None,
    routing is recorded as 'gemini-api'. The dashboard hides the pill for
    this default case."""
    Models, persist_mock = gemini_patched
    Models._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Models()
    client._api_client = types.SimpleNamespace(vertexai=False)
    client.generate_content(model="gemini-x", contents=[])

    record = persist_mock.call_args.args[0]
    assert record.metadata["routing"] == "gemini-api"


def test_routing_metadata_absent_when_sdk_internals_unrecognised(gemini_patched) -> None:
    """If `_api_client` is missing entirely (defensive case for future SDK
    refactors), routing is silently omitted. Tracing still completes."""
    Models, persist_mock = gemini_patched
    Models._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Models()
    # Deliberately leave _api_client unset (None).
    client._api_client = None
    client.generate_content(model="gemini-x", contents=[])

    record = persist_mock.call_args.args[0]
    assert "routing" not in record.metadata


def test_routing_metadata_flows_through_streaming(gemini_patched) -> None:
    """Streaming path also records routing on the flushed record."""
    Models, persist_mock = gemini_patched
    Models._impl_stream = staticmethod(
        lambda **kwargs: iter(
            [{"candidates": [{"content": {"role": "model", "parts": [{"text": "hi"}]}}]}]
        )
    )

    client = Models()
    client._api_client = types.SimpleNamespace(vertexai=True)
    stream = client.generate_content_stream(model="gemini-x", contents=[])
    list(stream)

    record = persist_mock.call_args.args[0]
    assert record.metadata["routing"] == "vertex"
