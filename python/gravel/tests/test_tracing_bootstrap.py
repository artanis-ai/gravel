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

import httpx
import pytest
import sqlalchemy as sa
from sqlalchemy import create_engine

from fastapi import FastAPI
from fastapi.testclient import TestClient

from artanis_gravel import GravelConfig
from artanis_gravel.asgi import _build_context as build_asgi_context
from artanis_gravel.django import _build_proto_context as build_django_context
from artanis_gravel.fastapi import create_gravel_router
from artanis_gravel.samples_query import list_samples
from artanis_gravel.schema import gravel_feedback, gravel_samples, metadata
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

    We use `httpx` (a transport the fetch patch covers — and a real
    project dep, unlike `requests`) and point it at a stub HTTP server
    whose path matches the LLM classifier so the patch records it as
    a real call.
    """
    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)
    create_gravel_router(_config(url))

    # OpenAI-shape URL on our local stub. The classifier matches
    # `/v1/chat/completions` regardless of host.
    response = httpx.post(
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

    # CRITICAL: read through the dashboard's actual read path, not raw
    # `sa.select(gravel_samples)`. Before v0.5.23 this was the audit
    # gap — the write path worked, the raw-select read worked, but
    # `list_samples` (the /api/samples handler) blew up on the same
    # data because SQLAlchemy's DateTime result-processor was applied
    # over an INTEGER-typed column (Go bootstrap → unix ms) and
    # `datetime.fromisoformat(int_ms)` raised TypeError. Any future
    # divergence between persister-written rows and the dashboard
    # read path must fail loudly here.
    engine2 = create_engine(url)
    result = list_samples(engine=engine2, page=1, page_size=10)
    engine2.dispose()
    assert result["total"] == 1
    assert len(result["samples"]) == 1
    api_row = result["samples"][0]
    assert api_row["model"] == "gpt-4o-mini"
    assert api_row["status"] == "completed"
    # Dashboard renders started_at as an ISO string; it must NOT be an
    # int (regression check for the unix-ms-leaking-to-API bug).
    assert isinstance(api_row["started_at"], str)
    assert "T" in api_row["started_at"], (
        f"started_at should be an ISO datetime string, got {api_row['started_at']!r}"
    )


def test_list_samples_against_go_bootstrapped_db(tmp_path: Path) -> None:
    """The original landlord-ai bug: the customer-side DB is bootstrapped
    by the Go SDK (`cli/internal/migrate/sql/sqlite_bootstrap.sql`),
    which declares timestamp / started_at / completed_at / created_at
    as `INTEGER NOT NULL DEFAULT (unixepoch() * 1000)`. The Python SDK
    used to declare those columns `DateTime(timezone=True)`, and on
    read SQLAlchemy's DateTime processor blew up with
    `fromisoformat: argument must be str` when the value was an int
    (e.g. created_at from the server default).

    This test reproduces the exact on-disk schema the Go bootstrap
    creates, inserts the same shape of row the persister writes
    (pre-v0.5.23: ISO text in the INTEGER column due to SQLite's
    loose typing; post-v0.5.23: int ms), and asserts list_samples
    works for both. The cross-stack mismatch must never bite a
    customer again.
    """
    db_file = tmp_path / "go-bootstrapped.db"
    # Recreate the Go bootstrap's DDL verbatim — the customer-on-disk shape.
    raw = create_engine(f"sqlite:///{db_file}")
    with raw.begin() as conn:
        conn.execute(
            sa.text(
                """
                CREATE TABLE gravel_samples (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    group_id TEXT,
                    environment TEXT,
                    model TEXT,
                    status TEXT NOT NULL DEFAULT 'completed',
                    input TEXT,
                    output TEXT,
                    metadata TEXT,
                    timestamp INTEGER NOT NULL,
                    started_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    duration_ms INTEGER,
                    commit_sha TEXT,
                    prompt_id TEXT,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
                )
                """
            )
        )
        conn.execute(
            sa.text(
                """
                CREATE TABLE gravel_feedback (
                    id TEXT PRIMARY KEY,
                    sample_id TEXT NOT NULL REFERENCES gravel_samples(id),
                    comment TEXT,
                    correction TEXT,
                    score TEXT,
                    source TEXT NOT NULL DEFAULT 'ui',
                    reporter_user_id TEXT,
                    metadata TEXT,
                    timestamp INTEGER NOT NULL,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
                )
                """
            )
        )
        # Row 1: a *legacy* pre-v0.5.23 write — the Python persister
        # passed a datetime, SQLAlchemy serialised to ISO text,
        # SQLite stored the text in the INTEGER column (loose typing).
        # This is the exact shape landlord-ai's gravel.db had.
        conn.execute(
            sa.text(
                """INSERT INTO gravel_samples
                   (id, name, environment, model, status, timestamp, started_at, completed_at, duration_ms)
                   VALUES ('legacy', 'openai.chat.completions.create', 'prod', 'gpt-4o', 'completed',
                           '2026-05-13 22:28:58.896860', '2026-05-13 22:28:58.896860',
                           '2026-05-13 22:29:02.077599', 3200)"""
            )
        )
        # Row 2: a *new* v0.5.23+ write — int ms, the persister's
        # post-fix bind shape via GravelTimestamp.
        conn.execute(
            sa.text(
                """INSERT INTO gravel_samples
                   (id, name, environment, model, status, timestamp, started_at, completed_at, duration_ms)
                   VALUES ('current', 'openai.chat.completions.create', 'prod', 'gpt-4o', 'completed',
                           1747171738896, 1747171738896, 1747171742077, 3200)"""
            )
        )
    raw.dispose()

    # The actual dashboard read path.
    engine = create_engine(f"sqlite:///{db_file}")
    result = list_samples(engine=engine, page=1, page_size=10)
    engine.dispose()

    assert result["total"] == 2
    by_id = {s["id"]: s for s in result["samples"]}
    assert set(by_id) == {"legacy", "current"}
    # Both rows must round-trip to an ISO string on the API response.
    for sid in ("legacy", "current"):
        s = by_id[sid]
        assert isinstance(s["started_at"], str), f"{sid}.started_at is {type(s['started_at'])}"
        assert "T" in s["started_at"] or "-" in s["started_at"], s["started_at"]


# -------------------- 4. /api/samples/:id response shape parity --------------------


def test_api_samples_detail_shape_matches_dashboard_contract(tmp_path: Path) -> None:
    """The dashboard's SampleReviewDialog destructures
    `const { sample, feedback } = data` from the /api/samples/:id
    response and reads `sample.input`. Pre-v0.5.24 the Python handler
    returned a flat object — destructure produced `sample === undefined`
    and the dialog crashed with `Cannot read properties of undefined
    (reading 'input')`.

    This test stands up the full handler chain (FastAPI router →
    dispatcher → samples_query.get_sample_detail), hits /api/samples/:id
    against a real DB-backed install, and asserts every field the
    dashboard's `SampleDetailResponse` interface declares. Any future
    drift between the Python response and the TS dashboard contract
    must fail here. The TS canon lives in
    `packages/sdk-ts/src/samples/query.ts:SampleDetail` and is mirrored
    in `packages/dashboard/src/lib/types.ts:SampleDetailResponse`.
    """
    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)
    engine = create_engine(url)

    # Seed a sample + one feedback row sharing a group_id with a second
    # sample, so we exercise the `related` array path too.
    with engine.begin() as conn:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        conn.execute(
            gravel_samples.insert().values(
                id="s-detail",
                name="openai.chat.completions.create",
                environment="prod",
                model="gpt-4o-mini",
                status="completed",
                group_id="trace-1",
                timestamp=now,
                started_at=now,
                completed_at=now,
                duration_ms=42,
                input={"messages": [{"role": "user", "content": "hi"}]},
                output={"choices": [{"message": {"role": "assistant", "content": "hello"}}]},
                metadata={"tokens_input": 4, "tokens_output": 2},
                commit_sha="deadbeef",
            )
        )
        conn.execute(
            gravel_samples.insert().values(
                id="s-related",
                name="openai.chat.completions.create",
                environment="prod",
                model="gpt-4o-mini",
                status="completed",
                group_id="trace-1",
                timestamp=now,
                started_at=now,
                completed_at=now,
            )
        )
        conn.execute(
            gravel_feedback.insert().values(
                id="f-1",
                sample_id="s-detail",
                comment="off-topic",
                correction="should mention X",
                score="negative",
                reporter_user_id="u-1",
                source="ui",
                timestamp=now,
            )
        )
    engine.dispose()

    app = FastAPI()
    cfg = GravelConfig(
        database={"url": url},
        auth={"default_password": "test-password"},
        mount_path="/admin/ai",
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    client = TestClient(app)

    login = client.post("/admin/ai/api/auth/login", json={"password": "test-password"})
    assert login.status_code == 200
    cookie = login.headers["set-cookie"]

    res = client.get("/admin/ai/api/samples/s-detail", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    data = res.json()

    # Top-level shape — SampleDetailResponse.
    assert set(data) == {"sample", "feedback", "related"}, (
        f"Top-level keys must be exactly sample/feedback/related; got {sorted(data)}. "
        "Dashboard's `const { sample, feedback } = data` requires this."
    )

    s = data["sample"]
    # Every SampleListItem field the dashboard reads, plus the
    # detail-only fields (commit_sha / input / output / metadata).
    required_sample_keys = {
        "id", "name", "model", "environment", "status", "group_id",
        "started_at", "completed_at", "duration_ms",
        "tokens_in", "tokens_out", "feedback_count", "feedback_score",
        "commit_sha", "input", "output", "metadata",
    }
    missing = required_sample_keys - set(s)
    assert not missing, f"sample is missing keys the dashboard needs: {missing}"
    assert s["id"] == "s-detail"
    assert s["model"] == "gpt-4o-mini"
    assert s["commit_sha"] == "deadbeef"
    # input/output must be present and non-None — this is what
    # `extractMessages(sample.input)` calls in SampleReviewDialog.
    assert s["input"] is not None
    assert s["output"] is not None
    assert s["feedback_count"] == 1
    assert s["feedback_score"] == "negative"
    # Tokens from metadata.
    assert s["tokens_in"] == 4
    assert s["tokens_out"] == 2

    # FeedbackItem shape per packages/dashboard/src/lib/types.ts.
    assert len(data["feedback"]) == 1
    fb = data["feedback"][0]
    required_feedback_keys = {
        "id", "sample_id", "comment", "correction", "score",
        "reporter_user_id", "created_at",
    }
    missing_fb = required_feedback_keys - set(fb)
    assert not missing_fb, f"feedback row is missing keys: {missing_fb}"
    assert fb["sample_id"] == "s-detail"
    assert fb["score"] == "negative"
    # `created_at` (TS canon) — must NOT be `timestamp` (the old Python name).
    assert isinstance(fb["created_at"], str)
    assert "timestamp" not in fb, (
        "feedback row must use `created_at` not `timestamp` — the dashboard "
        "FeedbackItem interface declares created_at"
    )

    # Related samples sharing this one's group_id.
    assert len(data["related"]) == 1
    assert data["related"][0]["id"] == "s-related"
    # Related rows must be SampleListItem-shaped (no input/output/metadata).
    related_keys = set(data["related"][0])
    assert "tokens_in" in related_keys
    assert "feedback_count" in related_keys


def test_sdk_patch_does_not_double_record_via_fetch(tmp_path: Path, llm_server: str) -> None:
    """Each LLM call must produce exactly ONE sample, not two.

    Pre-v0.5.25 the openai / anthropic / langchain SDK patches AND
    the fetch patch both recorded the same call — the SDK ultimately
    routes through httpx which fetch_patch wraps. Result: landlord-ai
    had 6 samples for 3 LLM calls (each row duplicated as
    `openai.chat.completions.create` + `fetch:openai.chat.completions`).

    Fix: SDK patches now wrap `original(...)` with
    `gravel_context_singleton.run_with_fetch_tracing_disabled(...)`
    which sets a contextvar fetch_patch reads to suppress its own
    recording. TS canon (`packages/sdk-ts/src/tracing/context.ts`)
    has the same mechanism — this is the Python port.

    This test mimics the customer chain: simulate an SDK patch by
    wrapping a real httpx call (which the fetch patch IS intercepting)
    in `run_with_fetch_tracing_disabled`. Assert exactly zero samples
    land via the fetch path. Then verify that WITHOUT the wrapper,
    the same call DOES land — proving the patch isn't dead.
    """
    import httpx
    from artanis_gravel.tracing import gravel_context_singleton

    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)
    create_gravel_router(_config(url))

    # Sanity: a bare httpx call IS captured by the fetch patch.
    httpx.post(
        f"{llm_server}/v1/chat/completions",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "x"}]},
        timeout=5,
    )
    engine = create_engine(url)
    with engine.begin() as conn:
        baseline = conn.execute(sa.select(sa.func.count()).select_from(gravel_samples)).scalar()
    engine.dispose()
    assert baseline == 1, f"baseline fetch capture broken; got {baseline} samples"

    # Now simulate what the SDK patches do: suppress fetch tracing for
    # the duration of the underlying http call. Should add ZERO new rows.
    gravel_context_singleton.run_with_fetch_tracing_disabled(
        lambda: httpx.post(
            f"{llm_server}/v1/chat/completions",
            json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "y"}]},
            timeout=5,
        )
    )
    engine = create_engine(url)
    with engine.begin() as conn:
        after = conn.execute(sa.select(sa.func.count()).select_from(gravel_samples)).scalar()
    engine.dispose()
    assert after == baseline, (
        f"SDK-suppressed httpx call must NOT add a row; baseline={baseline} after={after}. "
        "If this fails the dedup contextvar is broken and customers will see "
        "duplicate rows for every openai/anthropic call."
    )

    # And after exiting the context, the next httpx call IS captured
    # again (context-var must reset cleanly).
    httpx.post(
        f"{llm_server}/v1/chat/completions",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "z"}]},
        timeout=5,
    )
    engine = create_engine(url)
    with engine.begin() as conn:
        final = conn.execute(sa.select(sa.func.count()).select_from(gravel_samples)).scalar()
    engine.dispose()
    assert final == baseline + 1, (
        "after exiting run_with_fetch_tracing_disabled, fetch tracing must resume — "
        "otherwise the contextvar is leaking"
    )


def test_openai_patch_round_trip_writes_exactly_one_sample(
    tmp_path: Path, llm_server: str, monkeypatch
) -> None:
    """Plumb the wire end-to-end: hijack `openai.OpenAI.chat.completions.create`
    to call a real fake HTTP server (so the fetch patch is in the request
    path), then invoke it via the openai SDK and assert exactly one
    row lands. Pins the openai_patch ↔ fetch_patch dedup contract."""
    try:
        import openai  # noqa: F401
    except ImportError:
        pytest.skip("openai SDK not installed in test env")

    from openai import OpenAI

    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)
    create_gravel_router(_config(url))

    # Point the openai client at our local fake server.
    client = OpenAI(api_key="sk-test", base_url=llm_server)
    client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
    )

    engine = create_engine(url)
    with engine.begin() as conn:
        rows = list(
            conn.execute(sa.select(gravel_samples.c.name)).all()
        )
    engine.dispose()
    # Exactly one row, and it's the SDK-patch row (richer trace) —
    # NOT the fetch-patch row (which would be the duplicate).
    assert len(rows) == 1, (
        f"expected exactly one sample for one openai call, got {len(rows)}: {rows}. "
        "If this is 2, the dedup contextvar isn't being read by fetch_patch."
    )
    assert rows[0][0] == "openai.chat.completions.create"


def test_api_samples_detail_404_for_unknown_id(tmp_path: Path) -> None:
    """Defensive: the handler must 404 (not 500, not return None as
    JSON null) when the requested sample doesn't exist."""
    url = _sqlite_url(tmp_path)
    _bootstrap_tables(url)

    app = FastAPI()
    cfg = GravelConfig(
        database={"url": url},
        auth={"default_password": "test-password"},
        mount_path="/admin/ai",
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    client = TestClient(app)
    login = client.post("/admin/ai/api/auth/login", json={"password": "test-password"})
    cookie = login.headers["set-cookie"]
    res = client.get("/admin/ai/api/samples/does-not-exist", headers={"cookie": cookie})
    assert res.status_code == 404
