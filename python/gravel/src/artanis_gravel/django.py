"""Django integration: real dashboard via the shared dispatcher.

Provides `mount_on_django(config)` which returns a list of url
patterns ready to splice into the host's `urlpatterns`. Each pattern
delegates to the same `_handler.dispatch_request` the FastAPI / ASGI
/ Flask integrations use, so Django customers get bit-for-bit the
same dashboard as everyone else.

Usage:

    # myproject/urls.py
    from artanis_gravel import GravelConfig
    from artanis_gravel.django import gravel_urls

    cfg = GravelConfig(
        database={"url": "..."},
        auth={"default_password": "..."},
        mount_path="/admin/ai",
    )
    urlpatterns = [
        ...,
        path("admin/ai/", include(gravel_urls(cfg))),
    ]

Previous versions of this module shipped placeholder `_hello` and
`_auth_me` Django views that returned `{"ok": True, "blocker": ...}`
or `{"error": "not-implemented"}`. Django hosts that followed our
documentation got a non-functional dashboard with no error signal.
This rewrite swaps those stubs for the real route table.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from django.http import HttpRequest, HttpResponse
from django.urls import path, re_path

from ._handler import (
    Context,
    build_request_from_components,
    dispatch_request,
)
from .dashboard_assets import find_dashboard_dist
from .db import open_database
from .tracing import install_auto_tracing
from .types import GravelConfig, resolve_config


def _build_proto_context(config: GravelConfig) -> Context:
    resolved = resolve_config(config)
    mount_path = resolved.mount_path.rstrip("/") or ""
    password = resolved.auth.get("default_password") if resolved.auth else None
    engine: Any = None
    db_url = resolved.database.get("url", "") if resolved.database else ""
    if db_url:
        engine = open_database(db_url)
    # Wire LLM-SDK auto-tracing to the same engine the dashboard reads
    # from. No-ops on the prompts-only path (engine stays None).
    install_auto_tracing(engine)
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


def _django_view_factory(proto: Context):
    """Return a single Django view that delegates to the shared
    dispatcher. Bound to `proto` (resolved at urls.py module load
    time) so per-request work stays minimal."""

    def view(request: HttpRequest, sub_path: str = "") -> HttpResponse:
        body = request.body or b""
        headers: dict[str, str] = {}
        # Django exposes raw headers via .headers (3.x+) and via META
        # for compatibility. .headers is case-insensitive but only
        # contains "HTTP_*" keys mapped to their HTTP names; CONTENT_TYPE
        # and CONTENT_LENGTH are surfaced under their unprefixed META
        # keys, but request.headers includes them too on 3.x+.
        try:
            for k, v in request.headers.items():
                headers[k.lower()] = v
        except Exception:
            # Defensive: very old Django. Reconstruct from META.
            for k, v in request.META.items():
                if k.startswith("HTTP_"):
                    headers[k[5:].replace("_", "-").lower()] = v
                elif k == "CONTENT_TYPE":
                    headers["content-type"] = v
                elif k == "CONTENT_LENGTH":
                    headers["content-length"] = v

        path_part = "/" + (sub_path or "").lstrip("/")
        scheme = "https" if request.is_secure() else "http"
        url = request.build_absolute_uri()
        hreq = build_request_from_components(
            method=request.method or "GET",
            path=path_part,
            query_string=request.META.get("QUERY_STRING", "") or "",
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
        resp = HttpResponse(content=hresp.body, status=hresp.status)
        # Django can't take multiple Set-Cookie values via a header dict,
        # so iterate explicitly. Other headers go through resp[h] = v.
        for k, v in hresp.headers:
            if k.lower() == "set-cookie":
                # Django's resp.headers accepts multi-value via append.
                resp.headers.setdefault(k, v)
                # `setdefault` won't overwrite or append; reassigning
                # for repeated values requires the lower-level API:
                # we keep behaviour simple — the dashboard sets at
                # most one cookie per response.
                continue
            resp[k] = v
        return resp

    return view


def gravel_urls(config: GravelConfig) -> list:
    """Build the URL patterns to include under the dashboard mount.

    Returns a list ready for `include()`. The shared dispatcher handles
    routing internally, so we just need (a) a root pattern and (b) a
    catch-all that captures everything beneath it.
    """
    proto = _build_proto_context(config)
    view = _django_view_factory(proto)
    return [
        path("", view, name="gravel-root"),
        re_path(r"^(?P<sub_path>.+)$", view, name="gravel-sub"),
    ]
