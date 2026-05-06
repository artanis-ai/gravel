"""Unit tests for `artanis_gravel.tracing.langchain_patch`.

Langchain isn't installed in CI. We fake the minimum surface the patch
imports: `langchain_core.callbacks.BaseCallbackHandler` and
`langchain_core.tracers.context.register_configure_hook`. We then drive the
handler directly via its `on_llm_start` / `on_llm_end` etc. callbacks (the
same way Langchain's runtime would).
"""
from __future__ import annotations

import importlib
import sys
import types
from unittest.mock import MagicMock
from uuid import uuid4

import pytest


def _build_fake_langchain() -> dict:
    """Install minimal langchain_core surface; return `{registered_vars}` so
    tests can assert that our handler was registered."""
    state = {"registered": []}

    pkg = types.ModuleType("langchain_core")
    callbacks_mod = types.ModuleType("langchain_core.callbacks")
    tracers_mod = types.ModuleType("langchain_core.tracers")
    context_mod = types.ModuleType("langchain_core.tracers.context")

    class BaseCallbackHandler:
        """Stand-in that just stores no state. Our handler subclasses it."""

        def __init__(self) -> None:
            pass

    callbacks_mod.BaseCallbackHandler = BaseCallbackHandler  # type: ignore[attr-defined]

    def register_configure_hook(context_var, inheritable, *args, **kwargs):
        state["registered"].append((context_var, inheritable))

    context_mod.register_configure_hook = register_configure_hook  # type: ignore[attr-defined]

    sys.modules["langchain_core"] = pkg
    sys.modules["langchain_core.callbacks"] = callbacks_mod
    sys.modules["langchain_core.tracers"] = tracers_mod
    sys.modules["langchain_core.tracers.context"] = context_mod
    return state


@pytest.fixture
def langchain_patched(monkeypatch: pytest.MonkeyPatch):
    state = _build_fake_langchain()
    sys.modules.pop("artanis_gravel.tracing.langchain_patch", None)
    langchain_patch = importlib.import_module("artanis_gravel.tracing.langchain_patch")

    persist_mock = MagicMock(return_value="trace_id_test")
    monkeypatch.setattr(langchain_patch, "persist_trace", persist_mock)

    installed = langchain_patch.install()
    assert installed is True
    assert state["registered"], "configure hook not registered"

    handler = langchain_patch._handler_var.get()
    assert handler is not None

    yield handler, persist_mock, langchain_patch

    langchain_patch.uninstall()
    for mod in list(sys.modules):
        if mod == "langchain_core" or mod.startswith("langchain_core."):
            del sys.modules[mod]
    sys.modules.pop("artanis_gravel.tracing.langchain_patch", None)


def test_llm_run_persists_trace(langchain_patched) -> None:
    handler, persist_mock, _ = langchain_patched

    run_id = uuid4()
    handler.on_llm_start(
        serialized={"name": "OpenAI", "kwargs": {"model_name": "gpt-x"}},
        prompts=["say hi"],
        run_id=run_id,
    )
    handler.on_llm_end(response={"generations": [[{"text": "hi"}]]}, run_id=run_id)

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.name == "langchain.llm"
    assert record.status == "ok"
    assert record.model == "gpt-x"
    input_obs = next(o for o in record.observations if o.type == "input")
    assert input_obs.data["prompts"] == ["say hi"]
    output_obs = next(o for o in record.observations if o.type == "output")
    assert "generations" in output_obs.data


def test_chat_model_run_persists(langchain_patched) -> None:
    handler, persist_mock, _ = langchain_patched

    run_id = uuid4()
    handler.on_chat_model_start(
        serialized={"name": "ChatOpenAI", "kwargs": {"model": "gpt-x"}},
        messages=[[{"role": "user", "content": "hi"}]],
        run_id=run_id,
    )
    handler.on_llm_end(response={"text": "hi"}, run_id=run_id)

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.name == "langchain.chat_model"
    assert record.status == "ok"


def test_chain_error_persists_with_status(langchain_patched) -> None:
    handler, persist_mock, _ = langchain_patched

    run_id = uuid4()
    handler.on_chain_start(
        serialized={"name": "MyChain"},
        inputs={"q": "what?"},
        run_id=run_id,
    )
    handler.on_chain_error(error=RuntimeError("kaboom"), run_id=run_id)

    persist_mock.assert_called_once()
    record = persist_mock.call_args.args[0]
    assert record.name == "langchain.chain"
    assert record.status == "errored"
    err_obs = next(o for o in record.observations if o.type == "error")
    assert err_obs.data["type"] == "RuntimeError"
    assert "kaboom" in err_obs.data["message"]


def test_disabled_via_env_skips_persist(monkeypatch: pytest.MonkeyPatch, langchain_patched) -> None:
    handler, persist_mock, _ = langchain_patched
    monkeypatch.setenv("GRAVEL_TRACING_DISABLED", "1")

    run_id = uuid4()
    handler.on_llm_start(serialized={}, prompts=["x"], run_id=run_id)
    handler.on_llm_end(response={}, run_id=run_id)

    # Because on_llm_start short-circuited, there's no run state and the end
    # callback finds nothing to flush. No persist call should occur.
    persist_mock.assert_not_called()


def test_per_call_disable_skips_persist(langchain_patched) -> None:
    from artanis_gravel.tracing import with_tracing_disabled

    handler, persist_mock, _ = langchain_patched

    run_id = uuid4()
    with with_tracing_disabled():
        handler.on_llm_start(serialized={}, prompts=["x"], run_id=run_id)
        handler.on_llm_end(response={}, run_id=run_id)

    persist_mock.assert_not_called()


def test_metadata_context_flows_into_record(langchain_patched) -> None:
    from artanis_gravel.tracing import with_gravel_metadata

    handler, persist_mock, _ = langchain_patched

    run_id = uuid4()
    with with_gravel_metadata({"route": "/chat"}):
        handler.on_llm_start(
            serialized={"kwargs": {"model": "gpt-x"}},
            prompts=["x"],
            run_id=run_id,
        )
        handler.on_llm_end(response={}, run_id=run_id)

    record = persist_mock.call_args.args[0]
    assert record.metadata["route"] == "/chat"


def test_tool_events_attach_to_parent_run(langchain_patched) -> None:
    handler, persist_mock, _ = langchain_patched

    parent = uuid4()
    tool_run = uuid4()
    handler.on_chain_start(serialized={}, inputs={}, run_id=parent)
    handler.on_tool_start(
        serialized={"name": "search"},
        input_str="weather",
        run_id=tool_run,
        parent_run_id=parent,
    )
    handler.on_tool_end(output="sunny", run_id=tool_run, parent_run_id=parent)
    handler.on_chain_end(outputs={"final": "ok"}, run_id=parent)

    record = persist_mock.call_args.args[0]
    state_obs = [o for o in record.observations if o.type == "state"]
    assert len(state_obs) == 2
    assert state_obs[0].data["event"] == "tool_start"
    assert state_obs[0].data["tool"] == "search"
    assert state_obs[1].data["event"] == "tool_end"
    assert state_obs[1].data["output"] == "sunny"


def test_install_returns_false_if_langchain_missing() -> None:
    """Sanity: when langchain_core isn't installed, install() returns False
    and doesn't raise. We simulate by stripping it from sys.modules and
    blocking imports."""
    for mod in list(sys.modules):
        if mod == "langchain_core" or mod.startswith("langchain_core."):
            del sys.modules[mod]
    sys.modules.pop("artanis_gravel.tracing.langchain_patch", None)

    # Use a meta_path finder that blocks langchain_core.
    class _Blocker:
        def find_spec(self, name, path=None, target=None):
            if name == "langchain_core" or name.startswith("langchain_core."):
                raise ModuleNotFoundError(name)
            return None

    blocker = _Blocker()
    sys.meta_path.insert(0, blocker)
    try:
        langchain_patch = importlib.import_module("artanis_gravel.tracing.langchain_patch")
        assert langchain_patch.install() is False
    finally:
        sys.meta_path.remove(blocker)
        sys.modules.pop("artanis_gravel.tracing.langchain_patch", None)
