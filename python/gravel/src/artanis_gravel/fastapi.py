"""FastAPI integration.

BLOCKER: full implementation lands alongside the dashboard wiring.
The router currently provides minimal scaffolding (auth check, hello-world)
so users can verify the install reached the dashboard route.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from .types import GravelConfig, resolve_config


def create_gravel_router(config: GravelConfig) -> APIRouter:
    resolved = resolve_config(config)
    router = APIRouter()

    @router.get("/")
    async def root() -> dict:
        return {
            "product": resolved.product_name,
            "mount_path": resolved.mount_path,
            "ok": True,
            "blocker": "Dashboard SPA + full route table land alongside v0 build.",
        }

    @router.get("/api/auth/me")
    async def auth_me(request: Request) -> dict:
        # BLOCKER: wire actual get_user delegation.
        return {"error": "not-implemented"}

    return router
