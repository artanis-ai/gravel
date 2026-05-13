"""FastAPI integration: thin adapter over `_handler.dispatch_request`.

The route table itself lives in `_handler.py` so the FastAPI, ASGI,
WSGI, and Django integrations all hit identical behaviour. This file
is just the adapter that converts FastAPI's `Request` into a
`HandlerRequest` and the resulting `HandlerResponse` back into a
FastAPI `Response`.

Previously this module hand-rolled every route, which is how the
"hard-coded `CURRENT_VERSION = '0.1.0'`" + "/api/github/status returns
False" stubs ended up shipping for five releases without anyone
noticing. Centralising the dispatch table fixes that bug class.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ._handler import (
    Context,
    build_request_from_components,
    dispatch_request,
)
from .dashboard_assets import find_dashboard_dist
from .db import open_database
from .types import GravelConfig, resolve_config


def create_gravel_router(config: GravelConfig, *, engine: Any = None) -> APIRouter:
    """Build the dashboard router.

    If `engine` is None we open one from `config.database['url']`. The
    prompts-only install (no DATABASE_URL) keeps engine=None and the
    samples routes degrade to empty-page responses; the rest of the
    dashboard (auth, prompts list/detail/submit, version, GitHub
    install, migrations status) is fully functional without a DB.
    """
    resolved = resolve_config(config)
    mount_path = resolved.mount_path.rstrip("/") or ""
    password = resolved.auth.get("default_password") if resolved.auth else None
    if engine is None:
        db_url = resolved.database.get("url", "") if resolved.database else ""
        if db_url:
            engine = open_database(db_url)

    dist = find_dashboard_dist()
    shell_html = (dist / "index.html").read_text(encoding="utf-8") if dist else None
    assets_dir = (dist / "assets") if dist else None

    ctx_proto = Context(
        config=resolved,
        engine=engine,
        password=password,
        shell_html=shell_html,
        assets_dir=assets_dir,
        mount_path=mount_path,
    )

    router = APIRouter()

    async def _bridge(request: Request, sub_path: str) -> Response:
        """Single FastAPI handler that all routes delegate to. Sub_path
        is whatever lives under the mount point (FastAPI strips the
        APIRouter prefix before our wildcard captures the rest)."""
        body = await request.body()
        url = str(request.url)
        scheme = request.url.scheme or "http"
        # FastAPI's Request.headers is a Starlette Headers which is a
        # mapping-of-str. Coerce to plain dict for the handler.
        headers = {k: v for k, v in request.headers.items()}
        # `sub_path` from the catch-all already lacks a leading slash;
        # the dispatcher normalises and adds it.
        hreq = build_request_from_components(
            method=request.method,
            path="/" + sub_path,
            query_string=request.url.query or "",
            headers=headers,
            body=body,
            url=url,
            scheme=scheme,
        )
        # Build a per-request Context so concurrent requests don't share
        # the `user` field on the proto.
        ctx = Context(
            config=ctx_proto.config,
            engine=ctx_proto.engine,
            password=ctx_proto.password,
            shell_html=ctx_proto.shell_html,
            assets_dir=ctx_proto.assets_dir,
            mount_path=ctx_proto.mount_path,
        )
        hresp = dispatch_request(hreq, ctx)
        starlette_headers: list[tuple[bytes, bytes]] = []
        for k, v in hresp.headers:
            starlette_headers.append((k.encode("latin-1"), v.encode("latin-1")))
        return Response(
            content=hresp.body,
            status_code=hresp.status,
            headers={k: v for k, v in hresp.headers},
        )

    # Root + a catch-all for everything under it. FastAPI requires
    # separate definitions for "" and the wildcard so root requests
    # also reach _bridge.
    @router.api_route("/", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def root(request: Request) -> Response:
        return await _bridge(request, "")

    @router.api_route("/{sub_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def sub(request: Request, sub_path: str) -> Response:
        return await _bridge(request, sub_path)

    return router
