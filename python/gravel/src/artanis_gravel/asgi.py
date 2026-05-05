"""Generic ASGI / WSGI integration.

BLOCKER: full ASGI app lands alongside the dashboard wiring. v0 exposes
a minimal scaffolding so users can verify the route is reachable.
"""
from __future__ import annotations

import json
from typing import Any

from .types import GravelConfig, resolve_config


class GravelAsgiApp:
    """Mountable ASGI application. Stub for v0."""

    def __init__(self, config: GravelConfig) -> None:
        self.config = resolve_config(config)

    async def __call__(self, scope: dict, receive, send) -> None:
        if scope["type"] != "http":
            return
        body = json.dumps(
            {
                "ok": True,
                "product": self.config.product_name,
                "mount_path": self.config.mount_path,
                "blocker": "Full ASGI handler lands alongside v0 build.",
            }
        ).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"application/json")],
        })
        await send({"type": "http.response.body", "body": body})


def gravel_wsgi_app(config: GravelConfig):
    """Return a WSGI app for non-ASGI Python frameworks."""
    resolved = resolve_config(config)

    def app(environ: dict, start_response) -> list[bytes]:
        body = json.dumps(
            {
                "ok": True,
                "product": resolved.product_name,
                "mount_path": resolved.mount_path,
                "blocker": "Full WSGI handler lands alongside v0 build.",
            }
        ).encode("utf-8")
        start_response("200 OK", [("content-type", "application/json")])
        return [body]

    return app


# Suppress unused import.
_ = Any
