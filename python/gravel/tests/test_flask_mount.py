"""Tests for artanis_gravel.flask.mount_on_flask.

Verifies the WSGI dispatcher correctly forwards /admin/ai/* to the
FastAPI dashboard while passing everything else through to the user's
Flask app. Same dashboard routes that test_fastapi_prompts_only.py
covers — proves the FastAPI handler is reused intact via the bridge.
"""
from __future__ import annotations

import pytest

# Skip the whole module if the `[flask]` extra isn't installed in the
# test env. This is run by CI with the extra explicitly added.
pytest.importorskip("flask")
pytest.importorskip("a2wsgi")

from flask import Flask  # noqa: E402

from artanis_gravel import GravelConfig  # noqa: E402
from artanis_gravel.flask import mount_on_flask  # noqa: E402


def _flask_app_with_gravel(mount_path: str = "/admin/ai") -> Flask:
    """Build a Flask app with a single user route and the gravel
    dashboard mounted at `mount_path`. Returns the Flask app ready
    for test_client() use."""
    app = Flask(__name__)

    @app.route("/")
    def root():
        return "user-app-root"

    @app.route("/api/user")
    def api_user():
        return "user-api"

    mount_on_flask(
        app,
        GravelConfig(
            database={"url": ""},
            auth={"default_password": "test-password"},
            mount_path=mount_path,
        ),
    )
    return app


def test_mount_on_flask_preserves_user_routes():
    """The user's existing routes must continue to serve normally
    when gravel is mounted at /admin/ai."""
    app = _flask_app_with_gravel()
    client = app.test_client()

    res = client.get("/")
    assert res.status_code == 200, res.data
    assert res.data == b"user-app-root", res.data

    res = client.get("/api/user")
    assert res.status_code == 200, res.data
    assert res.data == b"user-api", res.data


def test_mount_on_flask_serves_gravel_api_version():
    """A request to /admin/ai/api/version must reach the FastAPI
    dashboard via the dispatcher, prove the prefix-strip works (the
    FastAPI app expects /api/version, not /admin/ai/api/version)."""
    app = _flask_app_with_gravel()
    client = app.test_client()
    res = client.get("/admin/ai/api/version")
    # Unauthenticated -> 401 (the dashboard requires login). What we
    # care about: it's a JSON response from the gravel API, NOT a
    # 404 from Flask saying the route doesn't exist.
    assert res.status_code in (200, 401), res.data
    assert b"current" in res.data or b"unauthorized" in res.data, res.data


def test_mount_on_flask_login_round_trip():
    """End-to-end login + authed-request via Flask -> dispatcher ->
    FastAPI -> SDK auth logic."""
    app = _flask_app_with_gravel()
    client = app.test_client()

    res = client.post(
        "/admin/ai/api/auth/login",
        json={"password": "test-password"},
    )
    assert res.status_code == 200, res.data
    cookie = res.headers.get("Set-Cookie")
    assert cookie, "login did not set a session cookie"
    # Forward cookie on a follow-up.
    res2 = client.get(
        "/admin/ai/api/auth/me",
        headers={"Cookie": cookie.split(";", 1)[0]},
    )
    assert res2.status_code == 200, res2.data


def test_mount_on_flask_invalid_password():
    """Wrong password through the dispatcher returns 401 from the
    SDK's auth route, not a Flask 404 or a 500."""
    app = _flask_app_with_gravel()
    client = app.test_client()
    res = client.post(
        "/admin/ai/api/auth/login",
        json={"password": "wrong"},
    )
    assert res.status_code == 401, res.data


def test_mount_on_flask_custom_mount_path():
    """The mount path is configurable via config.mount_path. Routes
    outside the prefix go to Flask; inside go to the dashboard."""
    app = _flask_app_with_gravel(mount_path="/dashboard")
    client = app.test_client()
    # Inside the mount path → dashboard
    res = client.get("/dashboard/api/version")
    assert res.status_code in (200, 401), res.data
    # Outside → Flask 404 (root and /api/user are defined, but
    # /admin/ai is not).
    res = client.get("/admin/ai/api/version")
    assert res.status_code == 404, res.data


def test_mount_on_flask_idempotent_double_call():
    """Calling mount_on_flask twice replaces the previous mount
    (last wins). User's other routes still work either way."""
    app = Flask(__name__)
    @app.route("/")
    def root():
        return "ok"

    cfg = GravelConfig(
        database={"url": ""},
        auth={"default_password": "pw"},
        mount_path="/admin/ai",
    )
    mount_on_flask(app, cfg)
    mount_on_flask(app, cfg)  # second call

    client = app.test_client()
    # User route still works.
    assert client.get("/").data == b"ok"
    # Dashboard still reachable.
    res = client.get("/admin/ai/api/version")
    assert res.status_code in (200, 401)


def test_mount_on_flask_missing_a2wsgi_raises_clear_error(monkeypatch):
    """If a2wsgi isn't installed, calling mount_on_flask raises a
    clear ImportError pointing the user at the install command."""
    import sys
    # Hide a2wsgi + reimport the flask module to force the failure path.
    monkeypatch.setitem(sys.modules, "a2wsgi", None)
    monkeypatch.delitem(sys.modules, "artanis_gravel.flask", raising=False)
    from importlib import reload, import_module
    flask_module = import_module("artanis_gravel.flask")
    reload(flask_module)

    app = Flask(__name__)
    cfg = GravelConfig(
        database={"url": ""},
        auth={"default_password": "pw"},
        mount_path="/admin/ai",
    )
    with pytest.raises(ImportError, match=r"artanis-gravel\[flask\]"):
        flask_module.mount_on_flask(app, cfg)
