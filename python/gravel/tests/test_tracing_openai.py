"""Unit tests for `artanis_gravel.tracing.openai_patch`.

The real `openai` package isn't installed in CI, so we synthesise a minimal
class hierarchy in `sys.modules` *before* importing the patch. The patch then
wraps those synthesised classes; we exercise them like the user would.

Each underlying `create` is a thin shim that delegates to a per-test callable
stored on the class — that lets us swap behaviour after installation, since
the patch's wrapper closes over the bound `create` at install time.

Persistence is mocked out — we assert on the captured `TraceRecord` shape.
"""
from __future__ import annotations

import importlib
import sys
import types
from typing import Any
from unittest.mock import MagicMock

import pytest


def _build_fake_openai() -> None:
    pkg = types.ModuleType("openai")
    resources = types.ModuleType("openai.resources")
    chat = types.ModuleType("openai.resources.chat")
    completions = types.ModuleType("openai.resources.chat.completions")
    embeddings_mod = types.ModuleType("openai.resources.embeddings")
    responses_mod = types.ModuleType("openai.resources.responses")

    class Completions:
        # Per-test override; default raises so a missing setup fails loudly.
        _impl = staticmethod(lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no impl")))

        def create(self, **kwargs: Any) -> Any:
            return type(self)._impl(**kwargs)

    class Embeddings:
        _impl = staticmethod(lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no impl")))

        def create(self, **kwargs: Any) -> Any:
            return type(self)._impl(**kwargs)

    class Responses:
        _impl = staticmethod(lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no impl")))

        def create(self, **kwargs: Any) -> Any:
            return type(self)._impl(**kwargs)

    completions.Completions = Completions  # type: ignore[attr-defined]
    embeddings_mod.Embeddings = Embeddings  # type: ignore[attr-defined]
    responses_mod.Responses = Responses  # type: ignore[attr-defined]

    sys.modules["openai"] = pkg
    sys.modules["openai.resources"] = resources
    sys.modules["openai.resources.chat"] = chat
    sys.modules["openai.resources.chat.completions"] = completions
    sys.modules["openai.resources.embeddings"] = embeddings_mod
    sys.modules["openai.resources.responses"] = responses_mod


@pytest.fixture
def openai_patched(monkeypatch: pytest.MonkeyPatch):
    _build_fake_openai()
    sys.modules.pop("artanis_gravel.tracing.openai_patch", None)
    openai_patch = importlib.import_module("artanis_gravel.tracing.openai_patch")

    persist_mock = MagicMock(return_value="trace_id_test")
    monkeypatch.setattr(openai_patch, "persist_trace", persist_mock)

    from openai.resources.chat.completions import Completions
    from openai.resources.embeddings import Embeddings

    yield Completions, Embeddings, persist_mock

    openai_patch.uninstall()
    for mod in list(sys.modules):
        if mod == "openai" or mod.startswith("openai."):
            del sys.modules[mod]
    sys.modules.pop("artanis_gravel.tracing.openai_patch", None)


def test_chat_completions_persists_trace(openai_patched) -> None:
    Completions, _, persist_mock = openai_patched

    fake = {"model": "gpt-5.4-nano", "choices": [{"message": {"content": "hi"}}]}
    Completions._impl = staticmethod(lambda **kwargs: fake)

    client = Completions()
    result = client.create(model="gpt-5.4-nano", messages=[{"role": "user", "content": "hi"}])
    assert result is fake

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.name == "openai.chat.completions.create"
    assert record.status == "ok"
    assert record.model == "gpt-5.4-nano"
    input_obs = next(o for o in record.observations if o.type == "input")
    assert input_obs.data["messages"][0]["content"] == "hi"
    output_obs = next(o for o in record.observations if o.type == "output")
    assert output_obs.data["choices"][0]["message"]["content"] == "hi"


def test_disabled_via_env_short_circuits(monkeypatch: pytest.MonkeyPatch, openai_patched) -> None:
    Completions, _, persist_mock = openai_patched
    monkeypatch.setenv("GRAVEL_TRACING_DISABLED", "1")
    Completions._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Completions()
    out = client.create(model="gpt-x", messages=[])
    assert out == {"ok": True}
    persist_mock.assert_not_called()


def test_error_propagates_and_persists(openai_patched) -> None:
    Completions, _, persist_mock = openai_patched

    class Boom(RuntimeError):
        pass

    def raising(**kwargs: Any) -> Any:
        raise Boom("upstream 500")

    Completions._impl = staticmethod(raising)

    client = Completions()
    with pytest.raises(Boom):
        client.create(model="gpt-x", messages=[])

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.status == "errored"
    err_obs = next(o for o in record.observations if o.type == "error")
    assert err_obs.data["type"] == "Boom"
    assert "upstream 500" in err_obs.data["message"]


def test_streaming_tees_and_persists_at_close(openai_patched) -> None:
    Completions, _, persist_mock = openai_patched

    chunks = [{"delta": "hel"}, {"delta": "lo"}, {"delta": "!"}]
    Completions._impl = staticmethod(lambda **kwargs: iter(chunks))

    client = Completions()
    stream = client.create(model="gpt-x", messages=[], stream=True)

    received = list(stream)
    assert received == chunks

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.status == "ok"
    output_obs = next(o for o in record.observations if o.type == "output")
    assert len(output_obs.data["chunks"]) == 3
    state_obs = next(o for o in record.observations if o.type == "state")
    assert state_obs.data["chunk_count"] == 3


def test_streaming_error_propagates_and_persists(openai_patched) -> None:
    Completions, _, persist_mock = openai_patched

    class Boom(RuntimeError):
        pass

    def gen():
        yield {"delta": "hel"}
        raise Boom("mid-stream")

    Completions._impl = staticmethod(lambda **kwargs: gen())

    client = Completions()
    stream = client.create(model="gpt-x", messages=[], stream=True)

    with pytest.raises(Boom):
        list(stream)

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.status == "errored"


def test_metadata_context_flows_into_record(openai_patched) -> None:
    from artanis_gravel.tracing import with_gravel_metadata

    Completions, _, persist_mock = openai_patched
    Completions._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Completions()
    with with_gravel_metadata({"user_id": "u_1"}):
        client.create(model="gpt-x", messages=[])

    record = persist_mock.call_args.args[0]
    assert record.metadata["user_id"] == "u_1"


def test_per_call_disable_short_circuits(openai_patched) -> None:
    from artanis_gravel.tracing import with_tracing_disabled

    Completions, _, persist_mock = openai_patched
    Completions._impl = staticmethod(lambda **kwargs: {"ok": True})

    client = Completions()
    with with_tracing_disabled():
        client.create(model="gpt-x", messages=[])

    persist_mock.assert_not_called()


def test_embeddings_patch_also_fires(openai_patched) -> None:
    _, Embeddings, persist_mock = openai_patched
    Embeddings._impl = staticmethod(lambda **kwargs: {"data": [[0.1, 0.2]]})

    client = Embeddings()
    client.create(model="text-embedding-3-small", input=["hello"])

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.name == "openai.embeddings.create"
