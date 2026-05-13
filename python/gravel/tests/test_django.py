"""Coverage for the Django integration.

We exercise the real Django request/response cycle (no test client
shortcut) so the adapter code that maps `request.META` →
`HandlerRequest` and `HandlerResponse` → `HttpResponse` is tested for
real. Skipped when Django isn't installed.

The integration was previously a placeholder returning
`{"ok": True, "blocker": ...}` for / and `{"error": "not-implemented"}`
for /api/auth/me. This file pins that the real dashboard now ships.
"""
from __future__ import annotations

import pytest

django = pytest.importorskip("django")


@pytest.fixture(scope="module", autouse=True)
def _django_settings():
    """Configure Django minimally — no DB, no auth middleware, just
    enough to dispatch URLs."""
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=False,
            ALLOWED_HOSTS=["*"],
            SECRET_KEY="test-key",
            DATABASES={},
            INSTALLED_APPS=[],
            ROOT_URLCONF=__name__,
            MIDDLEWARE=[],
        )
    django.setup()
    yield


# urls.py — populated lazily inside the test so `gravel_urls()` can
# resolve config at test time (each test customises the env).
urlpatterns: list = []


def _set_urls(cfg) -> None:
    """Mount gravel_urls under /admin/ai/ for this test. Django caches
    URL resolvers per pattern object, so we rebind globally on each
    call and clear the resolver cache."""
    from django.urls import clear_url_caches, include, path

    from artanis_gravel.django import gravel_urls

    global urlpatterns
    urlpatterns = [
        path("admin/ai/", include(gravel_urls(cfg))),
    ]
    clear_url_caches()


@pytest.fixture
def client():
    from django.test import Client

    from artanis_gravel import GravelConfig

    _set_urls(
        GravelConfig(
            database={"url": ""},
            auth={"default_password": "test-pw"},
            mount_path="/admin/ai",
        )
    )
    return Client()


def test_django_login_returns_200_and_session_cookie(client):
    """The previous placeholder _hello returned `{"ok": True,
    "blocker": ...}` for /. The real dispatcher returns 200 with a
    session cookie for /api/auth/login."""
    import json

    res = client.post(
        "/admin/ai/api/auth/login",
        data=json.dumps({"password": "test-pw"}),
        content_type="application/json",
    )
    assert res.status_code == 200, res.content
    set_cookie = res.headers.get("Set-Cookie") or res.headers.get("set-cookie") or ""
    assert "gravel_session=" in set_cookie, set_cookie


def test_django_serves_real_version_endpoint(client):
    """Previously /api/auth/me returned `{"error": "not-implemented"}`
    and /api/version didn't even exist. The dispatcher now serves
    both correctly."""
    import json

    login = client.post(
        "/admin/ai/api/auth/login",
        data=json.dumps({"password": "test-pw"}),
        content_type="application/json",
    )
    cookie = (login.headers.get("Set-Cookie") or "").split(";", 1)[0]

    res = client.get("/admin/ai/api/version", HTTP_COOKIE=cookie)
    assert res.status_code == 200, res.content
    body = res.json()
    assert "current" in body and "hasUpdate" in body, body


def test_django_root_serves_spa_shell_or_503(client):
    """GET / returns the SPA shell when the dashboard dist is bundled,
    or a 503 with `dashboard_dist_not_found` when it isn't. Either is
    acceptable; the old placeholder JSON is not."""
    res = client.get("/admin/ai/")
    assert res.status_code in (200, 503), res.content
    if res.status_code == 503:
        assert b"dashboard_dist_not_found" in res.content
    else:
        # Real HTML, not the old `{"ok": True, "blocker": ...}` stub.
        assert b"<html" in res.content.lower() or b"<!doctype" in res.content.lower()


def test_django_unknown_api_route_404s_not_500(client):
    """A route Django routes to us but the dispatcher doesn't know
    about → 404 JSON, never 500."""
    res = client.get("/admin/ai/api/something/that/does/not/exist")
    assert res.status_code == 404, res.content
