"""Unit tests for `artanis_gravel.tracing.anthropic_patch`.

Same setup style as `test_tracing_openai.py` — synthesise the SDK in
sys.modules, then import the patch.
"""
from __future__ import annotations

import importlib
import sys
import types
from typing import Any
from unittest.mock import MagicMock

import pytest


def _build_fake_anthropic() -> None:
    pkg = types.ModuleType("anthropic")
    resources = types.ModuleType("anthropic.resources")
    messages_mod = types.ModuleType("anthropic.resources.messages")

    class Messages:
        _impl = staticmethod(lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no impl")))

        def create(self, **kwargs: Any) -> Any:
            return type(self)._impl(**kwargs)

    messages_mod.Messages = Messages  # type: ignore[attr-defined]

    sys.modules["anthropic"] = pkg
    sys.modules["anthropic.resources"] = resources
    sys.modules["anthropic.resources.messages"] = messages_mod


@pytest.fixture
def anthropic_patched(monkeypatch: pytest.MonkeyPatch):
    _build_fake_anthropic()
    sys.modules.pop("artanis_gravel.tracing.anthropic_patch", None)
    anthropic_patch = importlib.import_module("artanis_gravel.tracing.anthropic_patch")

    persist_mock = MagicMock(return_value="trace_id_test")
    monkeypatch.setattr(anthropic_patch, "persist_trace", persist_mock)

    from anthropic.resources.messages import Messages

    yield Messages, persist_mock

    anthropic_patch.uninstall()
    for mod in list(sys.modules):
        if mod == "anthropic" or mod.startswith("anthropic."):
            del sys.modules[mod]
    sys.modules.pop("artanis_gravel.tracing.anthropic_patch", None)


def test_messages_create_persists_trace(anthropic_patched) -> None:
    Messages, persist_mock = anthropic_patched

    fake = {
        "id": "msg_1",
        "model": "claude-opus-4-7",
        "content": [{"type": "text", "text": "hi"}],
    }
    Messages._impl = staticmethod(lambda **kwargs: fake)

    client = Messages()
    result = client.create(model="claude-opus-4-7", messages=[{"role": "user", "content": "hi"}])
    assert result is fake

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.name == "anthropic.messages.create"
    assert record.status == "ok"
    assert record.model == "claude-opus-4-7"
    input_obs = next(o for o in record.observations if o.type == "input")
    assert input_obs.data["messages"][0]["content"] == "hi"


def test_disabled_via_env_short_circuits(monkeypatch: pytest.MonkeyPatch, anthropic_patched) -> None:
    Messages, persist_mock = anthropic_patched
    monkeypatch.setenv("GRAVEL_TRACING_DISABLED", "1")
    Messages._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Messages()
    out = client.create(model="claude", messages=[])
    assert out == {"ok": True}
    persist_mock.assert_not_called()


def test_error_propagates_and_persists(anthropic_patched) -> None:
    Messages, persist_mock = anthropic_patched

    class APIError(RuntimeError):
        pass

    def raising(**kwargs: Any) -> Any:
        raise APIError("anthropic 500")

    Messages._impl = staticmethod(raising)

    client = Messages()
    with pytest.raises(APIError):
        client.create(model="claude", messages=[])

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.status == "errored"
    err_obs = next(o for o in record.observations if o.type == "error")
    assert err_obs.data["type"] == "APIError"
    assert "anthropic 500" in err_obs.data["message"]


def test_streaming_tees_and_persists_at_close(anthropic_patched) -> None:
    Messages, persist_mock = anthropic_patched

    chunks = [{"event": "message_start"}, {"event": "content_block_delta", "text": "hi"}, {"event": "message_stop"}]
    Messages._impl = staticmethod(lambda **kwargs: iter(chunks))

    client = Messages()
    stream = client.create(model="claude", messages=[], stream=True)

    received = list(stream)
    assert received == chunks

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.status == "ok"
    output_obs = next(o for o in record.observations if o.type == "output")
    assert len(output_obs.data["chunks"]) == 3


def test_metadata_context_flows_into_record(anthropic_patched) -> None:
    from artanis_gravel.tracing import with_gravel_metadata

    Messages, persist_mock = anthropic_patched
    Messages._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Messages()
    with with_gravel_metadata({"session_id": "sess_42"}):
        client.create(model="claude", messages=[])

    record = persist_mock.call_args.args[0]
    assert record.metadata["session_id"] == "sess_42"


def test_per_call_disable_short_circuits(anthropic_patched) -> None:
    from artanis_gravel.tracing import with_tracing_disabled

    Messages, persist_mock = anthropic_patched
    Messages._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Messages()
    with with_tracing_disabled():
        client.create(model="claude", messages=[])

    persist_mock.assert_not_called()
