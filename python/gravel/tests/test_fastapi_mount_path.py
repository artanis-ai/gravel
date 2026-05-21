"""FastAPI adapter strips mount_path internally so the dashboard works
regardless of how the user wired the router.

Background (Yousef's de-platform install 2026-05-21):

  * The wizard's mount patcher writes `app.include_router(gravel_router,
    prefix='/admin/ai')`. With the prefix, FastAPI strips `/admin/ai/`
    before the wildcard captures, so `sub_path` is mount-relative
    (`"_assets/index.js"` for a request to `/admin/ai/_assets/index.js`).
    The dispatcher's asset-MIME check (`path.startswith("/_assets/")`)
    fires; we serve `application/javascript`.

  * If the prefix is missing (a Yousef-grade hand-edit, or a prior
    wizard's leftover include_router call), FastAPI does NOT strip
    anything. `sub_path` is the full `/admin/ai/_assets/index.js`. The
    dispatcher's asset check misses (path doesn't start with
    `/_assets/`); falls through to the SPA shell with `text/html`. The
    browser refuses to execute a `<script type="module">` with the
    wrong MIME; page silently goes blank.

The v0.10.3 fix: `_bridge` strips `ctx.mount_path` itself before
dispatching. Belt-and-suspenders alongside the wizard always emitting
the prefix (mount_python.go's isFastAPIAlreadyMounted). Either alone is
enough; both together make the failure mode unreachable.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from artanis_gravel import GravelConfig
from artanis_gravel.fastapi import create_gravel_router


def _config(mount_path: str = "/admin/ai") -> GravelConfig:
    return GravelConfig(
        database={"url": ""},
        auth={"default_password": "test-password"},
        mount_path=mount_path,
    )


def _login(client: TestClient, mount_path: str = "/admin/ai") -> str:
    resp = client.post(f"{mount_path}/api/auth/login", json={"password": "test-password"})
    assert resp.status_code == 200, resp.text
    return resp.headers["set-cookie"]


def test_mounted_with_prefix_serves_auth_route() -> None:
    """Canonical: include_router(prefix='/admin/ai'). Works."""
    app = FastAPI()
    app.include_router(create_gravel_router(_config()), prefix="/admin/ai")
    client = TestClient(app)
    cookie = _login(client)
    resp = client.get("/admin/ai/api/auth/me", headers={"cookie": cookie})
    assert resp.status_code == 200, resp.text


def test_mounted_without_prefix_still_serves_auth_route() -> None:
    """Bug 3 fix: include_router with NO prefix. Adapter strips
    mount_path internally so the dispatcher still sees mount-relative
    paths. Pre-v0.10.3 the dispatcher saw `/admin/ai/api/auth/me`,
    none of its route-prefix matches fired, and the request fell
    through to the SPA shell (404 for an API path, or text/html for
    asset paths)."""
    app = FastAPI()
    # No prefix= argument. This is the broken-shape Yousef hit.
    app.include_router(create_gravel_router(_config()))
    client = TestClient(app)
    cookie = _login(client)
    resp = client.get("/admin/ai/api/auth/me", headers={"cookie": cookie})
    assert resp.status_code == 200, resp.text


def test_mounted_without_prefix_serves_login_endpoint() -> None:
    """The login endpoint itself must work in the no-prefix case —
    otherwise the test above couldn't even acquire a cookie. Pinning
    the auth/login path explicitly so a future regression here surfaces
    a clear failure rather than a confusing 401 elsewhere."""
    app = FastAPI()
    app.include_router(create_gravel_router(_config()))
    client = TestClient(app)
    resp = client.post("/admin/ai/api/auth/login", json={"password": "test-password"})
    assert resp.status_code == 200, resp.text


def test_mounted_with_custom_mount_path_strips_correctly() -> None:
    """Mount at a non-default path; the strip logic uses ctx.mount_path
    so an arbitrary path works the same way."""
    app = FastAPI()
    app.include_router(create_gravel_router(_config(mount_path="/internal/observability")))
    client = TestClient(app)
    cookie = _login(client, mount_path="/internal/observability")
    resp = client.get("/internal/observability/api/auth/me", headers={"cookie": cookie})
    assert resp.status_code == 200, resp.text


def test_mounted_with_prefix_AND_custom_mount_path_works() -> None:
    """include_router(prefix=...) AND mount_path matching. Sub_path is
    already mount-relative; the strip is a no-op. Canonical happy path."""
    app = FastAPI()
    app.include_router(
        create_gravel_router(_config(mount_path="/internal/observability")),
        prefix="/internal/observability",
    )
    client = TestClient(app)
    cookie = _login(client, mount_path="/internal/observability")
    resp = client.get("/internal/observability/api/auth/me", headers={"cookie": cookie})
    assert resp.status_code == 200, resp.text
