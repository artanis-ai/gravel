"""Pins the prompts-only install path: a host with NO database configured
must still be able to import the router + serve auth / manifest / SPA
routes. Regression test for the bug Yousef hit running `gravel init
--no-traces` against landlord-ai: the SDK used to open the database
unconditionally and crash at module import."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from artanis_gravel import GravelConfig
from artanis_gravel.fastapi import create_gravel_router
from artanis_gravel.samples_query import gravel_tables_exist


def _config_without_db() -> GravelConfig:
    return GravelConfig(
        database={"url": ""},
        auth={"default_password": "test-password"},
        mount_path="/admin/ai",
    )


def test_create_gravel_router_no_database_does_not_open_engine():
    """Router builds successfully on a prompts-only install."""
    router = create_gravel_router(_config_without_db())
    # Routes must still be registered.
    paths = {r.path for r in router.routes}
    assert "/api/auth/me" in paths, paths
    assert "/api/version" in paths, paths
    assert "/api/samples" in paths, paths
    assert "/" in paths, paths


def test_gravel_tables_exist_handles_none_engine():
    """Used by sample/feedback routes to short-circuit when no DB."""
    assert gravel_tables_exist(None) is False


def test_samples_endpoint_returns_empty_page_no_db():
    """A logged-in user hitting /api/samples on a no-DB install sees
    the empty-page shape, not a 500."""
    app = FastAPI()
    app.include_router(create_gravel_router(_config_without_db()), prefix="/admin/ai")
    client = TestClient(app)

    # Login first so /api/samples doesn't 401.
    login = client.post(
        "/admin/ai/api/auth/login",
        json={"password": "test-password"},
    )
    assert login.status_code == 200, login.text
    # Forward the auth cookie on the next request.
    cookie = login.headers.get("set-cookie", "")
    assert cookie, "login did not set a session cookie"

    samples = client.get("/admin/ai/api/samples", headers={"cookie": cookie})
    assert samples.status_code == 200, samples.text
    body = samples.json()
    assert body == {"samples": [], "total": 0, "page": 1, "page_size": 20}, body


def test_resolve_config_accepts_empty_default_password():
    """REGRESSION: the wizard-generated gravel_config.py reads the
    password via os.environ.get(..., '') and passes the empty string
    to GravelConfig when the user hasn't loaded their .env yet. The
    SDK used to raise here, breaking app startup before the user
    could even see a useful error. We now check key PRESENCE, so an
    explicit `auth={'default_password': ''}` is treated as
    "configured but env not loaded" rather than "misconfigured".
    """
    from artanis_gravel.types import resolve_config
    # Should NOT raise.
    resolve_config(GravelConfig(
        database={"url": ""},
        auth={"default_password": ""},
        mount_path="/admin/ai",
    ))


def test_resolve_config_still_rejects_truly_empty_auth():
    """Sanity guard: an empty auth dict with NEITHER key still raises
    (otherwise users with a typo'd config get no signal at all)."""
    from artanis_gravel.types import resolve_config
    import pytest
    with pytest.raises(ValueError, match="Auth misconfigured"):
        resolve_config(GravelConfig(
            database={"url": ""},
            auth={},
            mount_path="/admin/ai",
        ))


def test_dashboard_root_no_db_does_not_500():
    """GET /admin/ai/ must not 500 when no DB is configured. The exact
    status depends on whether the dashboard SPA dist is bundled:
        200  - dashboard present, login page rendered
        503  - dashboard_dist_not_found (CI runs uv sync only, no
               `pnpm build`, so the dist isn't staged in the package)
        401  - auth gate (some SDK builds gate the SPA itself)
        404  - route table miss (would be a routing regression)

    What this test pins is the no-DB path: the SDK must not crash on
    an empty DATABASE_URL when serving the SPA root. The 503 dashboard
    case is acceptable here because it's a *separate* asset-bundling
    concern, not a DB explosion."""
    app = FastAPI()
    app.include_router(create_gravel_router(_config_without_db()), prefix="/admin/ai")
    client = TestClient(app)

    res = client.get("/admin/ai/", follow_redirects=False)
    assert res.status_code in (200, 401, 404, 503), res.text
    # If 503, confirm it's the bundle issue, not something else (catches
    # the case where a future SDK change makes 503 mean "DB unreachable"
    # or similar — we'd want to know).
    if res.status_code == 503:
        assert "dashboard_dist_not_found" in res.text, res.text
