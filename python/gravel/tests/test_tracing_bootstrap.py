"""End-to-end regression coverage for the auto-tracing bootstrap.

Pre-v0.5.22 every Python framework adapter (`fastapi.create_gravel_router`,
`asgi._build_context`, `django._build_proto_context`) opened the engine
but never imported `artanis_gravel.auto` and never called
`set_gravel_tracing_config(...)`. The wizard's traces pillar created
the gravel_* tables, printed "auto-tracing wired up", and customers
saw zero traces. Silent customer-visible failure, same bug class as
the v0.5.8 hardcoded `CURRENT_VERSION = "0.1.0"`.

The unit-level coverage of the patches existed (test_tracing_*) but
nothing exercised the seam — from the framework adapter through to a
row landing in `gravel_samples`. This file fills that gap:

  1. `install_auto_tracing` directly: engine wiring, env-var opt-out,
     None-engine no-op.
  2. The three adapters (FastAPI / ASGI / Django) all wire the
     persister when the config carries a DATABASE_URL.
  3. End-to-end: a fastapi router built from `create_gravel_router`
     causes a subsequent OpenAI-shaped POST (via `requests`, captured
     by the fetch patch) to land as a row in `gravel_samples`. This
     is the test that catches the actual bug — every other coverage
     missed it because we never reached past the in-memory persister.
"""
from __future__ import annotations

import http.server
import json
import os
import socket
import threading
from pathlib import Path
from typing import Any, Iterator

import pytest
import requests
import sqlalchemy as sa
from sqlalchemy import create_engine

from artanis_gravel import GravelConfig
from artanis_gravel.asgi import _build_context as build_asgi_context
from artanis_gravel.django import _build_proto_context as build_django_context
from artanis_gravel.fastapi import create_gravel_router
from artanis_gravel.schema import gravel_samples, metadata
from artanis_gravel.tracing import (
    install_auto_tracing,
    set_gravel_tracing_config,
)
from artanis_gravel.tracing.fetch_patch import _reset_for_tests as _reset_fetch
from artanis_gravel.tracing.persist import get_gravel_tracing_config


# -------------------- Module-scoped LLM-shape HTTP server --------------------


class _Handler(http.server.BaseHTTPRequestHandler):
    """Pretends to be api.openai.com — returns a chat-completions
    response so the fetch classifier records it as a real LLM call."""

    server_version = "GravelTracingBootstrapStub/1.0"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return  # quiet test output

    def do_POST(self) -> None:  # noqa: N802 — http.server requires this name
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length:
            self.rfile.read(length)  # drain
        body = json.dumps(
            {
                "id": "cmpl-bootstrap",
                "object": "chat.completion",
                "model": "gpt-4o-mini",
                "choices": [
                    {"message": {"role": "assistant", "content": "hello"}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2},
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def llm_server() -> Iterator[str]:
    """Spin up a tiny HTTP server that the fetch classifier will treat
    as api.openai.com (we hit it via a URL containing
    `/v1/chat/completions`). Yields the base URL."""
    server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


# -------------------- Helpers --------------------


def _sqlite_url(tmp_path: Path) -> str:
    """File-backed sqlite so a second engine opened against the same
    URL (the one create_gravel_router opens internally) sees the
    same data as the engine the test created the tables on."""
    return f"sqlite:///{tmp_path / 'gravel-traces.db'}"


def _bootstrap_tables(url: str) -> None:
    """Create gravel_samples + gravel_feedback on the test DB."""
    engine = create_engine(url)
    metadata.create_all(engine)
    engine.dispose()


def _config(url: str = "", mount_path: str = "/admin/ai") -> GravelConfig:
    return GravelConfig(
        database={"url": url},
        auth={"default_password": "test-password"},
        mount_path=mount_path,
    )


@pytest.fixture(autouse=True)
def _isolate_runtime_state(monkeypatch) -> Iterator[None]:
    """Each test starts with a pristine tracing runtime. Without this
    a prior test that installed the persister would leak into the
    None-engine assertions."""
    set_gravel_tracing_config(None)
    _reset_fetch()
    monkeypatch.delenv("GRAVEL_TRACING_DISABLED", raising=False)
    yield
    set_gravel_tracing_config(None)
    _reset_fetch()


# -------------------- 1. install_auto_tracing — direct coverage --------------------


def test_install_auto_tracing_wires_persister_when_engine_present(tmp_path: Path) -> None:
    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)
    engine = create_engine(url)
    installed = install_auto_tracing(engine)
    assert installed is True, "bootstrap helper must return True on the happy path"
    runtime = get_gravel_tracing_config()
    assert runtime is not None, "set_gravel_tracing_config must have been called"
    assert runtime.engine is engine, "persister engine must match the one passed in"


def test_install_auto_tracing_noop_on_none_engine() -> None:
    installed = install_auto_tracing(None)
    assert installed is False
    assert get_gravel_tracing_config() is None


def test_install_auto_tracing_respects_disabled_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("GRAVEL_TRACING_DISABLED", "1")
    engine = create_engine(_sqlite_url(tmp_path))
    installed = install_auto_tracing(engine)
    assert installed is False, "GRAVEL_TRACING_DISABLED=1 must short-circuit"
    assert get_gravel_tracing_config() is None


# -------------------- 2. Adapters wire the persister --------------------


def test_fastapi_router_wires_tracing(tmp_path: Path) -> None:
    """`create_gravel_router` with a DATABASE_URL must install auto-
    tracing — this is the exact path the wizard generates a host into.
    Pre-fix this assertion was False and customers saw zero traces."""
    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)
    create_gravel_router(_config(url))
    runtime = get_gravel_tracing_config()
    assert runtime is not None
    # `open_database` wraps the URL through SQLAlchemy's connection
    # plumbing which can normalise the slash count; just confirm the
    # engine resolves to the same database file we created.
    db_path = url.replace("sqlite:///", "")
    assert runtime.engine.url.database.rstrip("/").endswith(db_path)


def test_fastapi_router_no_tracing_on_prompts_only_install() -> None:
    """The prompts-only install path keeps engine=None — `install_auto_tracing`
    must no-op so the persister stays unwired (nothing to write to anyway)."""
    create_gravel_router(_config(url=""))
    assert get_gravel_tracing_config() is None


def test_asgi_build_context_wires_tracing(tmp_path: Path) -> None:
    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)
    build_asgi_context(_config(url))
    runtime = get_gravel_tracing_config()
    assert runtime is not None
    # `open_database` wraps the URL through SQLAlchemy's connection
    # plumbing which can normalise the slash count; just confirm the
    # engine resolves to the same database file we created.
    db_path = url.replace("sqlite:///", "")
    assert runtime.engine.url.database.rstrip("/").endswith(db_path)


def test_django_build_proto_context_wires_tracing(tmp_path: Path) -> None:
    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)
    build_django_context(_config(url))
    runtime = get_gravel_tracing_config()
    assert runtime is not None
    # `open_database` wraps the URL through SQLAlchemy's connection
    # plumbing which can normalise the slash count; just confirm the
    # engine resolves to the same database file we created.
    db_path = url.replace("sqlite:///", "")
    assert runtime.engine.url.database.rstrip("/").endswith(db_path)


# -------------------- 3. End-to-end: trace lands in gravel_samples --------------------


def test_fastapi_router_then_real_llm_call_writes_row(
    tmp_path: Path,
    llm_server: str,
) -> None:
    """The full chain a Python customer hits:

    1. `gravel init --traces` wizard creates the tables + emits gravel_route.py.
    2. The host's entrypoint imports gravel_route, which calls
       `create_gravel_router(config)`.
    3. Some downstream code makes an OpenAI-shaped HTTP call.

    Pre-v0.5.22 step 2 didn't import auto.py and didn't wire the
    persister, so step 3's captured trace had nowhere to land. This
    test asserts the full round-trip writes a row to gravel_samples.

    We use `requests` (a transport the fetch patch covers) and point
    it at a stub HTTP server whose path matches the LLM classifier
    so the patch records it as a real call.
    """
    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)
    create_gravel_router(_config(url))

    # OpenAI-shape URL on our local stub. The classifier matches
    # `/v1/chat/completions` regardless of host.
    response = requests.post(
        f"{llm_server}/v1/chat/completions",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "hi"}],
        },
        timeout=5,
    )
    assert response.status_code == 200
    assert response.json()["model"] == "gpt-4o-mini"

    engine = create_engine(url)
    with engine.begin() as conn:
        rows = list(conn.execute(sa.select(gravel_samples)))
    engine.dispose()

    assert len(rows) == 1, (
        f"expected exactly one captured sample, got {len(rows)}; "
        "if this is zero the auto-tracing bootstrap regressed and "
        "Python customers are seeing no traces again"
    )
    row = rows[0]._asdict()
    assert row["model"] == "gpt-4o-mini"
    assert row["status"] == "completed"
