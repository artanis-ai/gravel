"""Generic ASGI integration: real dashboard, not a placeholder.

Adapts the framework-agnostic `_handler.dispatch_request` to the raw
ASGI protocol so Starlette, Quart, BlackSheep, etc. can mount the
dashboard the same way FastAPI does — just point them at this app.

Also exposes `gravel_wsgi_app(config)` for WSGI-only frameworks
(Bottle, classic Flask without `[flask]` extra, etc.). The WSGI side
ALSO goes through the shared handler so behaviour stays in lockstep
with FastAPI / Django / Flask.

Previously this module shipped a placeholder returning a literal
"blocker: full ASGI handler lands alongside v0 build" JSON. That was
the same bug class as the `CURRENT_VERSION = '0.1.0'` stub: the
dashboard never worked for any host using the documented entry
point but the route 200'd, so nothing alerted.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from ._handler import (
    Context,
    HandlerRequest,
    HandlerResponse,
    build_request_from_components,
    dispatch_request,
)
from .dashboard_assets import find_dashboard_dist
from .db import open_database
from .types import GravelConfig, resolve_config


def _build_context(config: GravelConfig) -> Context:
    """Resolve config + dashboard dist once at construction time so we
    don't repeat the work per request. Engine opens lazily when a
    DATABASE_URL is configured; the prompts-only install keeps it None
    and the samples routes degrade to empty pages."""
    resolved = resolve_config(config)
    mount_path = resolved.mount_path.rstrip("/") or ""
    password = resolved.auth.get("default_password") if resolved.auth else None
    engine: Any = None
    db_url = resolved.database.get("url", "") if resolved.database else ""
    if db_url:
        engine = open_database(db_url)
    dist = find_dashboard_dist()
    shell_html = (dist / "index.html").read_text(encoding="utf-8") if dist else None
    assets_dir: Path | None = (dist / "assets") if dist else None
    return Context(
        config=resolved,
        engine=engine,
        password=password,
        shell_html=shell_html,
        assets_dir=assets_dir,
        mount_path=mount_path,
    )


# -------------------- ASGI --------------------


class GravelAsgiApp:
    """Mountable ASGI application backed by the shared dispatcher.

    Mount it under any prefix your framework supports — the prefix
    isn't stripped by the SDK so configure `mount_path` to match.
    Example with Starlette:

        from starlette.applications import Starlette
        from starlette.routing import Mount
        from artanis_gravel.asgi import GravelAsgiApp

        app = Starlette(routes=[Mount("/admin/ai", app=GravelAsgiApp(cfg))])
    """

    def __init__(self, config: GravelConfig) -> None:
        self._proto = _build_context(config)
        # Pre-strip the mount path's leading slash so we can compute
        # sub-paths cheaply at request time.
        self._mount_prefix = self._proto.mount_path.rstrip("/")

    async def __call__(
        self,
        scope: dict,
        receive: Callable[[], Awaitable[dict]],
        send: Callable[[dict], Awaitable[None]],
    ) -> None:
        if scope["type"] != "http":
            return
        body = await _read_body(receive)
        headers = {
            k.decode("latin-1").lower(): v.decode("latin-1")
            for k, v in scope.get("headers", [])
        }
        raw_path: str = scope.get("path", "/")
        # Strip the host-mounted prefix if the ASGI server (Starlette's
        # Mount, FastAPI's include_router) hasn't done it already.
        # `root_path` is the standard ASGI key for the mount prefix.
        root_path = scope.get("root_path", "") or ""
        sub_path = raw_path
        if root_path and sub_path.startswith(root_path):
            sub_path = sub_path[len(root_path) :] or "/"
        scheme = scope.get("scheme", "http")
        url = _build_url(scheme, headers.get("host", ""), raw_path, scope.get("query_string", b""))
        hreq = build_request_from_components(
            method=scope.get("method", "GET"),
            path=sub_path or "/",
            query_string=scope.get("query_string", b"").decode("latin-1"),
            headers=headers,
            body=body,
            url=url,
            scheme=scheme,
        )
        ctx = Context(
            config=self._proto.config,
            engine=self._proto.engine,
            password=self._proto.password,
            shell_html=self._proto.shell_html,
            assets_dir=self._proto.assets_dir,
            mount_path=self._proto.mount_path,
        )
        hresp = dispatch_request(hreq, ctx)
        await _send_response(send, hresp)


async def _read_body(receive: Callable[[], Awaitable[dict]]) -> bytes:
    """Drain the ASGI body stream into bytes. The dashboard's request
    bodies are tiny (login form, draft submissions); pre-buffering
    keeps the handler purely synchronous."""
    chunks: list[bytes] = []
    while True:
        msg = await receive()
        if msg["type"] != "http.request":
            continue
        chunks.append(msg.get("body", b"") or b"")
        if not msg.get("more_body"):
            break
    return b"".join(chunks)


async def _send_response(
    send: Callable[[dict], Awaitable[None]],
    resp: HandlerResponse,
) -> None:
    """ASGI response envelope: start + single body event."""
    headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in resp.headers]
    await send({"type": "http.response.start", "status": resp.status, "headers": headers})
    await send({"type": "http.response.body", "body": resp.body})


def _build_url(scheme: str, host: str, path: str, qs: bytes) -> str:
    base = f"{scheme}://{host}{path}"
    if qs:
        return f"{base}?{qs.decode('latin-1')}"
    return base


# -------------------- WSGI --------------------


def gravel_wsgi_app(config: GravelConfig):
    """Return a WSGI callable bound to the shared dispatcher. Useful
    for frameworks that don't speak ASGI natively (classic Flask is
    served via the `[flask]` integration instead, which uses a2wsgi
    against this same handler)."""
    proto = _build_context(config)

    def app(environ: dict, start_response) -> list[bytes]:
        headers = _wsgi_headers(environ)
        body = _read_wsgi_body(environ)
        path = environ.get("PATH_INFO", "/") or "/"
        scheme = environ.get("wsgi.url_scheme", "http")
        query = environ.get("QUERY_STRING", "") or ""
        host = headers.get("host", "")
        url = f"{scheme}://{host}{path}{('?' + query) if query else ''}"
        hreq = build_request_from_components(
            method=environ.get("REQUEST_METHOD", "GET"),
            path=path,
            query_string=query,
            headers=headers,
            body=body,
            url=url,
            scheme=scheme,
        )
        ctx = Context(
            config=proto.config,
            engine=proto.engine,
            password=proto.password,
            shell_html=proto.shell_html,
            assets_dir=proto.assets_dir,
            mount_path=proto.mount_path,
        )
        hresp = dispatch_request(hreq, ctx)
        status_line = _wsgi_status_line(hresp.status)
        start_response(status_line, list(hresp.headers))
        return [hresp.body]

    return app


def _wsgi_headers(environ: dict) -> dict[str, str]:
    """Reconstruct an HTTP header dict from a WSGI environ. Honors
    both the `HTTP_*` keys (for general headers) and the explicit
    `CONTENT_TYPE` / `CONTENT_LENGTH` keys WSGI insists on hoisting
    out of the HTTP_ namespace."""
    out: dict[str, str] = {}
    for k, v in environ.items():
        if k.startswith("HTTP_"):
            out[k[5:].replace("_", "-").lower()] = v
    if environ.get("CONTENT_TYPE"):
        out["content-type"] = environ["CONTENT_TYPE"]
    if environ.get("CONTENT_LENGTH"):
        out["content-length"] = environ["CONTENT_LENGTH"]
    return out


def _read_wsgi_body(environ: dict) -> bytes:
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except (TypeError, ValueError):
        length = 0
    if length <= 0:
        return b""
    return environ["wsgi.input"].read(length) or b""


def _wsgi_status_line(status: int) -> str:
    return f"{status} {_HTTP_REASONS.get(status, '')}"


_HTTP_REASONS = {
    200: "OK",
    302: "Found",
    303: "See Other",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    410: "Gone",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
}
