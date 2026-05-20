"""Real-SDK behavioural tests for the LangChain auto-patch.

The synthetic `test_tracing_langchain.py` invokes our callback
handler directly with handcrafted `Run` objects. That covers the
handler's logic but doesn't exercise LangChain's runtime dispatch
(configure_hook → on_llm_start / on_llm_end → recorded row).

This file uses LangChain's own `FakeListLLM` and `FakeListChatModel`
helpers (shipped with langchain_core for exactly this purpose:
testing tools that hook into LC's machinery without needing a real
provider). The dispatch path is identical to a real ChatOpenAI run.

Per the audit-seams-not-parts memory: "ground tests in live API
behaviour, not fictional class shapes."
"""
from __future__ import annotations

import importlib
import sys
from typing import Any, Iterator

import pytest
from sqlalchemy import Engine, create_engine, text

from artanis_gravel.db.bootstrap import bootstrap
from artanis_gravel.tracing.persist import (
    TracingRuntimeConfig,
    set_gravel_tracing_config,
)


def _ensure_real_langchain() -> Any:
    """test_tracing_langchain.py injects fake langchain_core into
    sys.modules. Force re-import the real one + reinstall the
    handler against it."""
    for mod in list(sys.modules):
        if mod == "langchain_core" or mod.startswith("langchain_core."):
            del sys.modules[mod]
    sys.modules.pop("artanis_gravel.tracing.langchain_patch", None)
    real_lc = pytest.importorskip("langchain_core")
    langchain_patch = importlib.import_module("artanis_gravel.tracing.langchain_patch")
    langchain_patch._PATCHED = False  # type: ignore[attr-defined]
    langchain_patch.install()
    return real_lc


@pytest.fixture(autouse=True)
def _reset_langchain_for_each_test() -> Iterator[Any]:
    real = _ensure_real_langchain()
    yield real


langchain_core = pytest.importorskip("langchain_core")
from artanis_gravel.tracing import install_auto_tracing  # noqa: E402


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


def test_fake_list_llm_invoke_records_row(engine_with_tracing: Engine) -> None:
    """A real LC LLM (FakeListLLM) flowing through .invoke() lands as
    a `langchain.llm` row. The handler's `on_llm_start` /
    `on_llm_end` fire via LC's own dispatch, NOT through synthesised
    Run objects."""
    from langchain_core.language_models.fake import FakeListLLM

    llm = FakeListLLM(responses=["hello world"])
    out = llm.invoke("what's up")
    assert out == "hello world"

    rows = _persisted_rows(engine_with_tracing)
    names = [r[0] for r in rows]
    assert "langchain.llm" in names, (
        f"expected langchain.llm row from FakeListLLM.invoke, got: {rows}"
    )


def test_fake_chat_model_invoke_records_row(engine_with_tracing: Engine) -> None:
    """A real LC chat model (FakeListChatModel) lands as a
    `langchain.chat_model` row (NOT `langchain.llm` — the handler
    must dispatch on `on_chat_model_start` vs `on_llm_start`)."""
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langchain_core.messages import HumanMessage

    chat = FakeListChatModel(responses=["chat response"])
    out = chat.invoke([HumanMessage(content="hi")])
    assert "chat response" in str(out.content)

    rows = _persisted_rows(engine_with_tracing)
    names = [r[0] for r in rows]
    assert "langchain.chat_model" in names, (
        f"expected langchain.chat_model row from FakeListChatModel, got: {rows}"
    )


def test_runnable_lambda_chain_records_row(engine_with_tracing: Engine) -> None:
    """Pure Python `RunnableLambda` invoked through LC produces a
    `langchain.chain` row. This exercises the chain code path
    independently of any LLM, which catches chain-handler bugs that
    LLM-only tests can't surface."""
    from langchain_core.runnables import RunnableLambda

    chain = RunnableLambda(lambda x: x.upper())
    out = chain.invoke("hello")
    assert out == "HELLO"

    rows = _persisted_rows(engine_with_tracing)
    names = [r[0] for r in rows]
    assert "langchain.chain" in names, (
        f"expected langchain.chain row from RunnableLambda, got: {rows}"
    )
