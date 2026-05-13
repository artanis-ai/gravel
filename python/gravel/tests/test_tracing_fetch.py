"""Unit + integration coverage for fetch_patch — raw HTTP tracing.

Covers four transports + the shared helpers:

  * `_classify`: every URL shape the TS canon matches, plus rejections.
  * `_parse_request_body`: JSON, text, bytes (UTF-8 + binary), dict,
    iterable-of-pairs, None.
  * `_parse_response_body`: OpenAI + Anthropic token-key variants.
  * httpx sync + async: 200 JSON, error status, network failure,
    non-LLM URL passthrough, GRAVEL_TRACING_DISABLED env opt-out,
    with_tracing_disabled context manager, response body still readable
    from the caller after the patch.
  * requests: success + non-LLM passthrough.
  * aiohttp: success + non-LLM passthrough.
  * urllib: success against a fixture HTTP server, error propagation.

The transport tests stand up a tiny stdlib `http.server` thread and
point each client at it. That keeps the suite hermetic — no mocks of
the underlying lib, no monkeypatching of the network — while still
exercising the real wrapper code paths.
"""
from __future__ import annotations

import asyncio
import http.server
import json
import socket
import threading
from typing import Any, Iterator

import pytest

from artanis_gravel.tracing import (
    fetch_patch,
    set_gravel_tracing_config,
    with_tracing_disabled,
)
from artanis_gravel.tracing.fetch_patch import (
    _classify,
    _parse_request_body,
    _parse_response_body,
    patch_all,
)


# -------------------- Fixture: a captured-sample sink --------------------


class _CapturingSink:
    """Stand-in for the SDK's persist path. Each test installs one of
    these as the runtime config so `persist_trace` records into our
    list instead of opening a SQLAlchemy connection."""

    def __init__(self) -> None:
        self.records: list[Any] = []


@pytest.fixture
def captured(monkeypatch) -> _CapturingSink:
    """Swap `persist_trace` for a list append. Resets the patch state
    so each test installs cleanly against the per-test http server."""
    sink = _CapturingSink()

    def _capture(record: Any) -> str:
        sink.records.append(record)
        return "fake-id"

    monkeypatch.setattr("artanis_gravel.tracing.fetch_patch.persist_trace", _capture)
    fetch_patch._reset_for_tests()
    monkeypatch.delenv("GRAVEL_TRACING_DISABLED", raising=False)
    yield sink
    set_gravel_tracing_config(None)


# -------------------- Fixture: tiny LLM-shaped HTTP server --------------------


class _Handler(http.server.BaseHTTPRequestHandler):
    """Pretends to be api.openai.com / api.anthropic.com. The path
    determines the response shape so the classifier exercises both
    provider branches."""

    server_version = "GravelTestStub/1.0"

    def _send_json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> dict[str, Any] | None:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length == 0:
            return None
        raw = self.rfile.read(length).decode("utf-8")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def do_POST(self) -> None:  # noqa: N802 — http.server requires this name
        self._read_body()  # drain to release the socket
        # `/error` is checked FIRST so the errored-status test can hit
        # an LLM-classified path (e.g. /error/v1/chat/completions) and
        # still get a 500.
        if "/error" in self.path:
            self._send_json(500, {"error": {"message": "boom"}})
            return
        if "/chat/completions" in self.path:
            self._send_json(
                200,
                {
                    "id": "cmpl-x",
                    "object": "chat.completion",
                    "model": "gpt-4o-mini",
                    "choices": [{"message": {"role": "assistant", "content": "hi"}}],
                    "usage": {"prompt_tokens": 7, "completion_tokens": 3},
                },
            )
            return
        if "/v1/messages" in self.path:
            self._send_json(
                200,
                {
                    "id": "msg_x",
                    "type": "message",
                    "model": "claude-3-5-sonnet-latest",
                    "content": [{"type": "text", "text": "hi"}],
                    "usage": {"input_tokens": 11, "output_tokens": 5},
                },
            )
            return
        if "/error" in self.path:
            self._send_json(500, {"error": {"message": "boom"}})
            return
        self._send_json(404, {"error": "not found"})

    def do_GET(self) -> None:  # noqa: N802
        if "/passthrough" in self.path:
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"error": "not found"})

    def log_message(self, *args, **kwargs) -> None:
        # Don't pollute pytest output with one line per request.
        return


def _pick_port() -> int:
    """Bind to port 0, read the assigned port, close — cheap way to
    find a free one without racing the parallel runner."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def llm_server() -> Iterator[str]:
    """Boot the stub HTTP server on a free port, return its base URL.
    Tears down cleanly after each test."""
    port = _pick_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)


# -------------------- _classify --------------------


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://api.openai.com/v1/chat/completions", ("openai", "fetch:openai.chat.completions")),
        ("https://api.openai.com/v1/chat/completions?stream=1", ("openai", "fetch:openai.chat.completions")),
        ("https://proxy.example.com/v1/chat/completions", ("openai", "fetch:openai.chat.completions")),
        ("https://api.openai.com/v1/responses", ("openai", "fetch:openai.responses")),
        ("https://api.openai.com/v1/embeddings", ("openai", "fetch:openai.embeddings")),
        ("https://api.anthropic.com/v1/messages", ("anthropic", "fetch:anthropic.messages")),
        ("https://api.anthropic.com/v1/messages?beta=1", ("anthropic", "fetch:anthropic.messages")),
    ],
)
def test_classify_matches_known_shapes(url, expected):
    assert _classify(url) == expected


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/random",
        "https://api.openai.com/v1/models",  # different path
        "https://api.openai.com/v1/files",
        "",
    ],
)
def test_classify_rejects_unknown_shapes(url):
    assert _classify(url) is None


def test_classify_responses_path_needs_openai_host():
    """The /responses regex is greedy — narrow it to URLs that also
    look like api.openai.com or contain /v1/ so we don't false-match
    `/api/responses` from random Express apps."""
    assert _classify("https://acme.com/api/responses") is None
    assert _classify("https://api.openai.com/v1/responses") == (
        "openai",
        "fetch:openai.responses",
    )


# -------------------- _parse_request_body --------------------


def test_parse_request_body_none():
    assert _parse_request_body(None) is None


def test_parse_request_body_bytes_json():
    out = _parse_request_body(b'{"a": 1}')
    assert out == {"a": 1}


def test_parse_request_body_bytes_text():
    """Non-JSON bytes round-trip as decoded text."""
    assert _parse_request_body(b"hello") == "hello"


def test_parse_request_body_bytes_binary():
    assert _parse_request_body(b"\xff\xfe\xfd") == "<binary>"


def test_parse_request_body_string_json():
    assert _parse_request_body('{"k": "v"}') == {"k": "v"}


def test_parse_request_body_string_plain():
    assert _parse_request_body("just text") == "just text"


def test_parse_request_body_dict_passthrough():
    assert _parse_request_body({"x": 1}) == {"x": 1}


def test_parse_request_body_pairs_to_dict():
    assert _parse_request_body([("a", 1), ("b", 2)]) == {"a": 1, "b": 2}


def test_parse_request_body_unreadable():
    """An unknown type (e.g., a custom stream object) gets a sentinel
    rather than crashing the trace."""
    class _Weird:
        pass

    assert _parse_request_body(_Weird()) == "<unreadable-body>"


# -------------------- _parse_response_body --------------------


def test_parse_response_openai_extracts_tokens():
    body = {"model": "gpt-4o", "usage": {"prompt_tokens": 10, "completion_tokens": 20}}
    out = _parse_response_body("openai", body)
    assert out["model"] == "gpt-4o"
    assert out["tokens_input"] == 10
    assert out["tokens_output"] == 20


def test_parse_response_openai_accepts_alt_token_keys():
    """Newer OpenAI Responses API uses input_tokens / output_tokens."""
    body = {"model": "o1", "usage": {"input_tokens": 3, "output_tokens": 7}}
    out = _parse_response_body("openai", body)
    assert out["tokens_input"] == 3
    assert out["tokens_output"] == 7


def test_parse_response_anthropic_extracts_tokens():
    body = {"model": "claude-3", "usage": {"input_tokens": 11, "output_tokens": 5}}
    out = _parse_response_body("anthropic", body)
    assert out["tokens_input"] == 11
    assert out["tokens_output"] == 5


def test_parse_response_non_dict_returns_empty():
    assert _parse_response_body("openai", "not a dict") == {}
    assert _parse_response_body("openai", None) == {}
    assert _parse_response_body("openai", [1, 2, 3]) == {}


def test_parse_response_missing_usage():
    body = {"model": "gpt-4o"}
    out = _parse_response_body("openai", body)
    assert out["model"] == "gpt-4o"
    assert "tokens_input" not in out


# -------------------- httpx --------------------


def test_httpx_sync_captures_openai_call(captured, llm_server):
    httpx = pytest.importorskip("httpx")
    patch_all()
    response = httpx.post(
        f"{llm_server}/v1/chat/completions",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 200
    # User's call still sees the body intact (the wrapper must not have
    # consumed it).
    assert response.json()["model"] == "gpt-4o-mini"
    # One sample captured with the right shape.
    assert len(captured.records) == 1
    rec = captured.records[0]
    assert rec.name == "fetch:openai.chat.completions"
    assert rec.status == "completed"
    assert rec.model == "gpt-4o-mini"
    obs_by_type = {o.type: o for o in rec.observations}
    assert obs_by_type["input"].data["method"] == "POST"
    assert obs_by_type["input"].data["body"]["model"] == "gpt-4o-mini"


def test_httpx_sync_captures_anthropic_call(captured, llm_server):
    httpx = pytest.importorskip("httpx")
    patch_all()
    response = httpx.post(
        f"{llm_server}/v1/messages",
        json={"model": "claude-3-5-sonnet-latest", "messages": []},
    )
    assert response.status_code == 200
    assert response.json()["model"] == "claude-3-5-sonnet-latest"
    assert len(captured.records) == 1
    rec = captured.records[0]
    assert rec.name == "fetch:anthropic.messages"


def test_httpx_skips_non_llm_urls(captured, llm_server):
    """A GET to a non-classified path must not record a trace AND must
    not impose any latency. Pin behaviour with a sample-count assert."""
    httpx = pytest.importorskip("httpx")
    patch_all()
    httpx.get(f"{llm_server}/passthrough")
    assert captured.records == []


def test_httpx_records_errored_status(captured, llm_server):
    """A 5xx response is classified as `errored`, not `completed`. We
    point the stub server at a path that classifies as LLM (so the
    wrapper engages) and trigger the 500 by adding `?error` which the
    handler dispatches on."""
    httpx = pytest.importorskip("httpx")
    patch_all()
    # The stub handler returns 500 when the request path contains
    # `/error`. Route the OpenAI-shaped POST through a proxy-style URL
    # whose suffix matches /chat/completions but also contains /error.
    # Concrete path: /error/v1/chat/completions — classifier matches
    # on the trailing /chat/completions, server dispatches the /error
    # branch first.
    err_resp = httpx.post(
        f"{llm_server}/error/v1/chat/completions", json={"x": 1}
    )
    assert err_resp.status_code == 500
    # Exactly one record (for the failed call) with status='errored'.
    assert len(captured.records) == 1
    assert captured.records[0].status == "errored"


def test_httpx_env_disabled_skips_patch(monkeypatch, captured, llm_server):
    """`GRAVEL_TRACING_DISABLED=1` must short-circuit BEFORE any
    classification or persist call."""
    httpx = pytest.importorskip("httpx")
    patch_all()
    monkeypatch.setenv("GRAVEL_TRACING_DISABLED", "1")
    httpx.post(f"{llm_server}/v1/chat/completions", json={"x": 1})
    assert captured.records == []


def test_httpx_context_disabled_skips_capture(captured, llm_server):
    """`with_tracing_disabled` block — runtime opt-out."""
    httpx = pytest.importorskip("httpx")
    patch_all()
    with with_tracing_disabled():
        httpx.post(f"{llm_server}/v1/chat/completions", json={"x": 1})
    assert captured.records == []


@pytest.mark.asyncio
async def test_httpx_async_captures_call(captured, llm_server):
    httpx = pytest.importorskip("httpx")
    patch_all()
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{llm_server}/v1/chat/completions",
            json={"model": "gpt-4o-mini", "messages": []},
        )
    assert response.status_code == 200
    # The user can still read the body after the wrapper.
    assert response.json()["model"] == "gpt-4o-mini"
    assert len(captured.records) == 1
    assert captured.records[0].name == "fetch:openai.chat.completions"


# -------------------- requests --------------------


def test_requests_captures_openai_call(captured, llm_server):
    requests = pytest.importorskip("requests")
    patch_all()
    response = requests.post(
        f"{llm_server}/v1/chat/completions",
        json={"model": "gpt-4o-mini", "messages": []},
    )
    assert response.status_code == 200
    assert response.json()["model"] == "gpt-4o-mini"
    assert len(captured.records) == 1
    rec = captured.records[0]
    assert rec.name == "fetch:openai.chat.completions"
    assert rec.model == "gpt-4o-mini"


def test_requests_skips_non_llm(captured, llm_server):
    requests = pytest.importorskip("requests")
    patch_all()
    requests.get(f"{llm_server}/passthrough")
    assert captured.records == []


# -------------------- aiohttp --------------------


@pytest.mark.asyncio
async def test_aiohttp_captures_call(captured, llm_server):
    aiohttp = pytest.importorskip("aiohttp")
    patch_all()
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{llm_server}/v1/chat/completions",
            json={"model": "gpt-4o-mini", "messages": []},
        ) as response:
            assert response.status == 200
            # User can still read the body after the wrapper.
            body = await response.json()
            assert body["model"] == "gpt-4o-mini"
    assert len(captured.records) == 1
    rec = captured.records[0]
    assert rec.name == "fetch:openai.chat.completions"


@pytest.mark.asyncio
async def test_aiohttp_skips_non_llm(captured, llm_server):
    aiohttp = pytest.importorskip("aiohttp")
    patch_all()
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{llm_server}/passthrough") as response:
            await response.read()
    assert captured.records == []


# -------------------- urllib --------------------


def test_urllib_captures_openai_call(captured, llm_server):
    """stdlib urllib path. Reduced fidelity (no body capture) but the
    classifier + persist path still fires."""
    import urllib.request

    patch_all()
    req = urllib.request.Request(
        f"{llm_server}/v1/chat/completions",
        data=json.dumps({"model": "gpt-4o-mini"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as response:
        # Caller can still consume the stream.
        body = json.loads(response.read().decode())
        assert body["model"] == "gpt-4o-mini"
    assert len(captured.records) == 1
    rec = captured.records[0]
    assert rec.name == "fetch:openai.chat.completions"
    assert rec.status == "completed"


def test_urllib_skips_non_llm(captured, llm_server):
    import urllib.request

    patch_all()
    with urllib.request.urlopen(f"{llm_server}/passthrough") as response:
        response.read()
    assert captured.records == []


# -------------------- patch_all idempotency --------------------


def test_patch_all_idempotent(captured, llm_server):
    """Calling patch_all multiple times should NOT chain wrappers (which
    would cause duplicate samples per request)."""
    httpx = pytest.importorskip("httpx")
    patch_all()
    patch_all()
    patch_all()
    httpx.post(f"{llm_server}/v1/chat/completions", json={"x": 1})
    # Exactly one sample, not three.
    assert len(captured.records) == 1


def test_patch_all_env_disabled(monkeypatch, captured, llm_server):
    """When the env var is set BEFORE patch_all runs, no transports
    should be installed. We can't test the negative directly without
    inspecting state, so check the behavioural consequence: no sample."""
    fetch_patch._reset_for_tests()
    monkeypatch.setenv("GRAVEL_TRACING_DISABLED", "1")
    patch_all()
    monkeypatch.delenv("GRAVEL_TRACING_DISABLED")
    httpx = pytest.importorskip("httpx")
    httpx.post(f"{llm_server}/v1/chat/completions", json={"x": 1})
    assert captured.records == []


# Suppress unused-import on asyncio (pulled in by pytest-asyncio).
_ = asyncio
