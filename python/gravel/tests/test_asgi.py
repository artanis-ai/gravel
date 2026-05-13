"""Coverage for the generic ASGI + WSGI adapters.

The route table is shared with FastAPI (tested in
`test_handler_routes.py`), so this file pins the ADAPTER behaviour:
  * ASGI request/response envelope is well-formed
  * `root_path` (ASGI mount-prefix) gets stripped before dispatch
  * WSGI status-line and headers come back right
  * Both adapters serve at least /api/auth/login → 200 with a cookie
"""
from __future__ import annotations

from io import BytesIO

import pytest

from artanis_gravel import GravelConfig
from artanis_gravel.asgi import GravelAsgiApp, gravel_wsgi_app


def _cfg() -> GravelConfig:
    return GravelConfig(
        database={"url": ""},
        auth={"default_password": "test-pw"},
        mount_path="/admin/ai",
    )


# -------------------- ASGI --------------------


@pytest.mark.asyncio
async def test_asgi_login_returns_200_and_set_cookie():
    """End-to-end ASGI cycle: scope → app → captured response.

    The test fakes `receive`/`send` so we can drive the app without an
    HTTP server. Confirms the response envelope is well-formed and
    the login cookie comes through."""
    app = GravelAsgiApp(_cfg())

    body = b'{"password": "test-pw"}'
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/auth/login",
        "root_path": "",
        "query_string": b"",
        "scheme": "http",
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
    }
    sent: list[dict] = []

    async def _receive() -> dict:
        return {"type": "http.request", "body": body, "more_body": False}

    async def _send(msg: dict) -> None:
        sent.append(msg)

    await app(scope, _receive, _send)
    starts = [m for m in sent if m["type"] == "http.response.start"]
    bodies = [m for m in sent if m["type"] == "http.response.body"]
    assert len(starts) == 1
    assert len(bodies) == 1
    assert starts[0]["status"] == 200, sent
    headers = dict((k.decode(), v.decode()) for k, v in starts[0]["headers"])
    assert "gravel_session=" in headers.get("set-cookie", "")


@pytest.mark.asyncio
async def test_asgi_strips_root_path_before_dispatch():
    """If the ASGI server mounted us under `/admin/ai` and put that in
    `root_path`, the dispatcher must see `/api/auth/login`, not the
    full path. Without the strip, every API call 404s."""
    app = GravelAsgiApp(_cfg())
    body = b'{"password": "test-pw"}'
    scope = {
        "type": "http",
        "method": "POST",
        # Server hands us the FULL path...
        "path": "/admin/ai/api/auth/login",
        # ...but root_path tells us which prefix to strip.
        "root_path": "/admin/ai",
        "query_string": b"",
        "scheme": "http",
        "headers": [(b"host", b"testserver"), (b"content-type", b"application/json")],
    }
    sent: list[dict] = []

    async def _receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def _send(msg):
        sent.append(msg)

    await app(scope, _receive, _send)
    status = [m for m in sent if m["type"] == "http.response.start"][0]["status"]
    assert status == 200, sent


@pytest.mark.asyncio
async def test_asgi_ignores_non_http_scope_types():
    """Websocket / lifespan messages must be a no-op, not a 500."""
    app = GravelAsgiApp(_cfg())
    sent: list[dict] = []

    async def _receive():
        return {"type": "lifespan.startup"}

    async def _send(msg):
        sent.append(msg)

    await app({"type": "websocket"}, _receive, _send)
    assert sent == []


# -------------------- WSGI --------------------


def test_wsgi_login_returns_200_and_set_cookie():
    app = gravel_wsgi_app(_cfg())
    body = b'{"password": "test-pw"}'
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/api/auth/login",
        "QUERY_STRING": "",
        "CONTENT_TYPE": "application/json",
        "CONTENT_LENGTH": str(len(body)),
        "HTTP_HOST": "testserver",
        "wsgi.url_scheme": "http",
        "wsgi.input": BytesIO(body),
    }
    captured: dict = {}

    def start_response(status: str, headers: list[tuple[str, str]]) -> None:
        captured["status"] = status
        captured["headers"] = headers

    out = app(environ, start_response)
    assert captured["status"].startswith("200 "), captured
    set_cookie = next((v for k, v in captured["headers"] if k.lower() == "set-cookie"), "")
    assert "gravel_session=" in set_cookie
    assert b'"ok":' in b"".join(out) or b'"ok"' in b"".join(out)


def test_wsgi_empty_body_does_not_crash():
    """GET with no Content-Length must not try to read a body."""
    app = gravel_wsgi_app(_cfg())
    environ = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": "/api/version",
        "QUERY_STRING": "",
        "HTTP_HOST": "testserver",
        "wsgi.url_scheme": "http",
        "wsgi.input": BytesIO(b""),
    }
    captured: dict = {}

    def start_response(status: str, headers: list[tuple[str, str]]) -> None:
        captured["status"] = status
        captured["headers"] = headers

    out = app(environ, start_response)
    assert captured["status"].startswith("401 "), captured  # not logged in, but no 500
    _ = out
