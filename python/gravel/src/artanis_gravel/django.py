"""Django integration.

BLOCKER: full implementation lands alongside the dashboard wiring. v0
exposes minimal urls.py-compatible patterns so users can verify the
install routed correctly.
"""
from __future__ import annotations

from django.http import JsonResponse
from django.urls import path


def _hello(_request) -> JsonResponse:
    return JsonResponse(
        {
            "ok": True,
            "blocker": "Dashboard SPA + full route table land alongside v0 build.",
        }
    )


def _auth_me(_request) -> JsonResponse:
    return JsonResponse({"error": "not-implemented"})


gravel_urls = [
    path("", _hello, name="gravel-root"),
    path("api/auth/me", _auth_me, name="gravel-auth-me"),
]
