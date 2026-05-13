"""End-to-end tests for every route the shared dispatcher handles.

Run through the FastAPI adapter using TestClient because that's the
cheapest fake — the routes themselves are framework-agnostic
(`_handler.dispatch_request` is what we're really testing). Coverage:

  * /api/auth/login: JSON + form-encoded, rate-limit, 303 redirects
  * /api/auth/logout: clears the cookie
  * /api/auth/view-as: admin gate + cookie set/clear
  * /api/migrations/status: no-db reason + admin gate
  * /api/github/status: connected=true when env vars are set
  * /api/github/install: dev-stub redirect
  * /api/github/install/callback: writes env vars + redirects
  * /api/prompts: uses manifest/io + GRAVEL_REPO_ROOT
  * /api/prompts/submit: validation + github_not_installed path
  * /_assets/<file>: correct content-type for known extensions
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from artanis_gravel import GravelConfig
from artanis_gravel._rate_limit import _reset_for_tests as reset_rate_limit
from artanis_gravel.fastapi import create_gravel_router


PASSWORD = "test-password"


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """Each test runs with a clean rate-limit bucket and clean GH env."""
    reset_rate_limit()
    for k in (
        "GRAVEL_GH_INSTALL_ID",
        "GRAVEL_GH_INSTALL_SECRET",
        "GRAVEL_GH_REPO_OWNER",
        "GRAVEL_GH_REPO_NAME",
        "GRAVEL_GH_DEV_STUB",
        "GRAVEL_GH_DEV_REPO_OWNER",
        "GRAVEL_GH_DEV_REPO_NAME",
        "GRAVEL_VERSION_CHECK_DISABLED",
    ):
        monkeypatch.delenv(k, raising=False)
    yield


def _mk_app(tmp_path: Path | None = None) -> tuple[TestClient, str]:
    """Build a FastAPI TestClient with the dashboard mounted at
    /admin/ai and return a logged-in cookie. Most route tests need
    the cookie, so we centralise the login."""
    if tmp_path is not None:
        import os
        os.chdir(tmp_path)
    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""},
        auth={"default_password": PASSWORD},
        mount_path="/admin/ai",
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    client = TestClient(app)
    login = client.post("/admin/ai/api/auth/login", json={"password": PASSWORD})
    assert login.status_code == 200, login.text
    cookie = login.headers.get("set-cookie", "")
    assert cookie
    return client, cookie


# --- /api/auth/login ----------------------------------------------------


def test_login_json_succeeds_returns_session_cookie():
    """Happy path: POST JSON with the right password gets 200 + cookie."""
    client, cookie = _mk_app()
    assert "gravel_session=" in cookie
    me = client.get("/admin/ai/api/auth/me", headers={"cookie": cookie})
    assert me.status_code == 200


def test_login_json_wrong_password_401():
    client, _ = _mk_app()
    res = client.post("/admin/ai/api/auth/login", json={"password": "nope"})
    assert res.status_code == 401, res.text
    assert res.json()["error"] == "invalid password"


def test_login_form_succeeds_303_with_location():
    """Form-encoded login must 303 back to the mount root, not return
    JSON. The bundled login page submits as a form."""
    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""}, auth={"default_password": PASSWORD}, mount_path="/admin/ai"
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    client = TestClient(app)
    res = client.post(
        "/admin/ai/api/auth/login",
        data={"password": PASSWORD},
        headers={"content-type": "application/x-www-form-urlencoded"},
        follow_redirects=False,
    )
    assert res.status_code == 303, res.text
    assert res.headers["location"] == "/admin/ai/"
    assert "gravel_session=" in res.headers.get("set-cookie", "")


def test_login_form_wrong_password_303_to_error():
    """Form-encoded login failure bounces to /login?error=1, never
    returns JSON (which the form-submit can't render)."""
    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""}, auth={"default_password": PASSWORD}, mount_path="/admin/ai"
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    client = TestClient(app)
    res = client.post(
        "/admin/ai/api/auth/login",
        data={"password": "wrong"},
        headers={"content-type": "application/x-www-form-urlencoded"},
        follow_redirects=False,
    )
    assert res.status_code == 303, res.text
    assert res.headers["location"] == "/admin/ai/login?error=1"
    # No cookie set on failure.
    assert "gravel_session" not in res.headers.get("set-cookie", "")


def test_login_rate_limit_kicks_in_after_max_attempts():
    """5th wrong password should still be a normal 401; the 6th is
    locked out with 429 + retry_after_ms."""
    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""}, auth={"default_password": PASSWORD}, mount_path="/admin/ai"
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    client = TestClient(app)
    # Five wrong attempts (the limit).
    for _ in range(5):
        r = client.post("/admin/ai/api/auth/login", json={"password": "nope"})
        assert r.status_code == 401, r.text
    # Sixth attempt — same IP — is locked out.
    r = client.post("/admin/ai/api/auth/login", json={"password": "nope"})
    assert r.status_code == 429, r.text
    body = r.json()
    assert body["error"] == "too many attempts"
    assert body["retry_after_ms"] > 0


def test_login_rate_limit_does_not_block_other_ips():
    """The bucket is keyed by IP. Spoof X-Forwarded-For for the 6th
    attempt and confirm we get 401 (the password is still wrong), not
    429 from the first IP's bucket."""
    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""}, auth={"default_password": PASSWORD}, mount_path="/admin/ai"
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    client = TestClient(app)
    for _ in range(5):
        client.post(
            "/admin/ai/api/auth/login",
            json={"password": "nope"},
            headers={"x-forwarded-for": "1.2.3.4"},
        )
    # Different IP → fresh bucket → 401, not 429.
    r = client.post(
        "/admin/ai/api/auth/login",
        json={"password": "nope"},
        headers={"x-forwarded-for": "5.6.7.8"},
    )
    assert r.status_code == 401, r.text


# --- /api/auth/logout ----------------------------------------------------


def test_logout_clears_session_cookie():
    client, cookie = _mk_app()
    res = client.post(
        "/admin/ai/api/auth/logout",
        headers={"cookie": cookie},
        follow_redirects=False,
    )
    assert res.status_code == 303, res.text
    assert res.headers["location"] == "/admin/ai/login"
    set_cookie = res.headers.get("set-cookie", "")
    assert "gravel_session=" in set_cookie
    assert "Max-Age=0" in set_cookie


# --- /api/auth/view-as ---------------------------------------------------


def test_view_as_admin_sets_cookie_to_user():
    client, cookie = _mk_app()
    res = client.post(
        "/admin/ai/api/auth/view-as",
        json={"mode": "user"},
        headers={"cookie": cookie},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body == {"ok": True, "view_as": "user"}, body
    sc = res.headers.get("set-cookie", "")
    assert "gravel_view_as=user" in sc


def test_view_as_clears_cookie_when_mode_missing():
    client, cookie = _mk_app()
    res = client.post(
        "/admin/ai/api/auth/view-as",
        json={"mode": None},
        headers={"cookie": cookie},
    )
    assert res.status_code == 200, res.text
    sc = res.headers.get("set-cookie", "")
    assert "gravel_view_as=" in sc
    assert "Max-Age=0" in sc


def test_view_as_unauthenticated_401():
    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""}, auth={"default_password": PASSWORD}, mount_path="/admin/ai"
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    res = TestClient(app).post("/admin/ai/api/auth/view-as", json={"mode": "user"})
    assert res.status_code == 401, res.text


# --- /api/migrations/status ---------------------------------------------


def test_migrations_status_no_db_returns_no_db_reason():
    client, cookie = _mk_app()
    res = client.get("/admin/ai/api/migrations/status", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["pending"] == 0
    assert body["dialect"] is None
    assert body["reason"] == "no-db"
    assert isinstance(body["autoMigrate"], bool)


def test_migrations_status_admin_only():
    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""}, auth={"default_password": PASSWORD}, mount_path="/admin/ai"
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    res = TestClient(app).get("/admin/ai/api/migrations/status")
    assert res.status_code == 401, res.text


# --- /api/github/status --------------------------------------------------


def test_github_status_connected_false_when_env_unset():
    client, cookie = _mk_app()
    res = client.get("/admin/ai/api/github/status", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body == {"connected": False, "repoOwner": None, "repoName": None}


def test_github_status_connected_true_when_env_set(monkeypatch):
    monkeypatch.setenv("GRAVEL_GH_INSTALL_ID", "12345")
    monkeypatch.setenv("GRAVEL_GH_INSTALL_SECRET", "deadbeef")
    monkeypatch.setenv("GRAVEL_GH_REPO_OWNER", "acme")
    monkeypatch.setenv("GRAVEL_GH_REPO_NAME", "app")
    client, cookie = _mk_app()
    res = client.get("/admin/ai/api/github/status", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body == {"connected": True, "repoOwner": "acme", "repoName": "app"}


def test_github_status_dev_stub_pretends_connected(monkeypatch):
    monkeypatch.setenv("GRAVEL_GH_DEV_STUB", "1")
    monkeypatch.setenv("GRAVEL_GH_DEV_REPO_OWNER", "acme")
    monkeypatch.setenv("GRAVEL_GH_DEV_REPO_NAME", "app")
    client, cookie = _mk_app()
    res = client.get("/admin/ai/api/github/status", headers={"cookie": cookie})
    assert res.json()["connected"] is True


# --- /api/github/install + callback -------------------------------------


def test_github_install_dev_stub_redirect(monkeypatch):
    monkeypatch.setenv("GRAVEL_GH_DEV_STUB", "1")
    monkeypatch.setenv("GRAVEL_GH_DEV_REPO_OWNER", "acme")
    monkeypatch.setenv("GRAVEL_GH_DEV_REPO_NAME", "app")
    client, cookie = _mk_app()
    res = client.get("/admin/ai/api/github/install", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    url = res.json()["redirectUrl"]
    assert "/admin/ai/api/github/install/callback" in url
    assert url.endswith("?gh=installed")


def test_github_install_returns_cp_redirect_url():
    """Without dev-stub, the install route returns a CP URL with our
    callback baked into return_to. We don't actually hit the CP."""
    client, cookie = _mk_app()
    res = client.get("/admin/ai/api/github/install", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    body = res.json()
    assert "/api/cli/github/install/start" in body["redirectUrl"]
    assert "return_to=" in body["redirectUrl"]


def test_github_install_callback_writes_env_and_redirects(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    client, cookie = _mk_app()
    res = client.get(
        "/admin/ai/api/github/install/callback",
        params={
            "installation_id": "12345",
            "install_secret": "deadbeef",
            "repo_owner": "acme",
            "repo_name": "app",
        },
        headers={"cookie": cookie},
        follow_redirects=False,
    )
    assert res.status_code == 302, res.text
    assert res.headers["location"] == "/admin/ai/?gh=installed"
    env_file = tmp_path / ".env.local"
    assert env_file.exists(), "env file was not created"
    content = env_file.read_text()
    assert "GRAVEL_GH_INSTALL_ID=12345" in content
    assert "GRAVEL_GH_REPO_OWNER=acme" in content


def test_github_install_callback_missing_params_redirects_anyway(monkeypatch, tmp_path):
    """If the callback fires without the expected params (CP retry,
    user tab close, etc.), we still bounce to the dashboard so the
    UI can show the not-installed state. We don't 500."""
    monkeypatch.chdir(tmp_path)
    client, cookie = _mk_app()
    res = client.get(
        "/admin/ai/api/github/install/callback",
        headers={"cookie": cookie},
        follow_redirects=False,
    )
    assert res.status_code == 302, res.text


# --- /api/prompts (uses GRAVEL_REPO_ROOT) -------------------------------


def test_prompts_list_uses_gravel_repo_root(monkeypatch, tmp_path):
    """Set GRAVEL_REPO_ROOT and ensure the handler reads the manifest
    from that path, not from os.getcwd()."""
    repo_root = tmp_path / "actual-repo"
    repo_root.mkdir()
    (repo_root / "src.py").write_text("ALPHA prompt text\n", encoding="utf-8")
    manifest = {
        "version": 1,
        "prompts": [
            {
                "id": "p_root1",
                "type": "embedded",
                "path": "src.py",
                "charStart": 0,
                "charEnd": 5,
                "lineStart": 1,
                "lineEnd": 1,
                "varName": "ALPHA",
                "hash": "0",
            }
        ],
    }
    (repo_root / ".gravel").mkdir()
    (repo_root / ".gravel" / "manifest.json").write_text(json.dumps(manifest))
    # cwd points elsewhere so we'd hit a different (empty) manifest
    # without GRAVEL_REPO_ROOT.
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("GRAVEL_REPO_ROOT", str(repo_root))

    client, cookie = _mk_app()
    res = client.get("/admin/ai/api/prompts", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    body = res.json()
    ids = [p["id"] for p in body["prompts"]]
    assert "p_root1" in ids, body
    assert body["prompts"][0]["preview"] == "ALPHA"


# --- /api/prompts/submit ------------------------------------------------


def test_prompts_submit_unauthenticated_401():
    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""}, auth={"default_password": PASSWORD}, mount_path="/admin/ai"
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    res = TestClient(app).post(
        "/admin/ai/api/prompts/submit", json={"drafts": [{"promptId": "p_a", "newText": "x"}]}
    )
    assert res.status_code == 401, res.text


def test_prompts_submit_no_drafts_400():
    client, cookie = _mk_app()
    res = client.post(
        "/admin/ai/api/prompts/submit",
        json={"drafts": []},
        headers={"cookie": cookie},
    )
    assert res.status_code == 400, res.text
    assert res.json()["error"] == "no_drafts"


def test_prompts_submit_invalid_draft_shape_400():
    client, cookie = _mk_app()
    res = client.post(
        "/admin/ai/api/prompts/submit",
        json={"drafts": [{"promptId": 123, "newText": "x"}]},
        headers={"cookie": cookie},
    )
    assert res.status_code == 400, res.text
    assert res.json()["error"] == "invalid_draft"


def test_prompts_submit_github_not_installed_409():
    """When the GH App isn't installed (env vars unset, no dev-stub),
    submit returns 409 with the documented copy. The dashboard reads
    the `error` field and shows the install card."""
    client, cookie = _mk_app()
    res = client.post(
        "/admin/ai/api/prompts/submit",
        json={"drafts": [{"promptId": "p_anything", "newText": "x"}]},
        headers={"cookie": cookie},
    )
    assert res.status_code == 409, res.text
    body = res.json()
    assert body["error"] == "github_not_installed"


# --- /_assets content-type -----------------------------------------------


def test_assets_path_traversal_does_not_leak_files(tmp_path, monkeypatch):
    """Build a fake dist + a sibling file we shouldn't be able to read,
    then prove no asset request can reach it via traversal. The URL
    normalisation done by the test client converts `..` segments
    before the request hits us, which is a layer of defense; the
    handler's own `"/" in filename` + `".." in filename` checks are
    the second layer."""
    secret_dir = tmp_path / "secrets"
    secret_dir.mkdir()
    (secret_dir / "passwd").write_text("PWNED", encoding="utf-8")
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    (dist / "assets" / "x.js").write_bytes(b"// safe asset\n")
    monkeypatch.setenv("GRAVEL_DASHBOARD_DIST", str(dist))

    client, cookie = _mk_app()
    # The %2F decodes to a slash, so the prefix matcher refuses to
    # capture a multi-segment filename.
    res = client.get("/admin/ai/_assets/..%2Fpasswd", headers={"cookie": cookie})
    assert b"PWNED" not in res.content, res.text
    # Sanity: the legit asset still works.
    ok = client.get("/admin/ai/_assets/x.js", headers={"cookie": cookie})
    assert ok.status_code == 200, ok.text


def test_assets_unknown_404(tmp_path, monkeypatch):
    """A request for a file the bundle doesn't contain → 404 not 500."""
    client, cookie = _mk_app()
    res = client.get("/admin/ai/_assets/nope-XYZ.js", headers={"cookie": cookie})
    # Either 404 (dist present, file missing) or 400 (no dist) — both
    # are acceptable non-500 responses.
    assert res.status_code in (400, 404), res.text


def test_assets_content_type_map_returns_correct_mime(tmp_path, monkeypatch):
    """Drop synthetic asset files into a fake dist and confirm the
    handler picks the right content-type for each extension."""
    # Build a fake dashboard dist with assorted files.
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body></body></html>")
    files = {
        "x.js": "application/javascript",
        "x.css": "text/css",
        "x.svg": "image/svg+xml",
        "x.woff2": "font/woff2",
        "x.png": "image/png",
        "x.json": "application/json",
    }
    for name in files:
        (dist / "assets" / name).write_bytes(b"x")
    monkeypatch.setenv("GRAVEL_DASHBOARD_DIST", str(dist))

    client, cookie = _mk_app()
    for name, expected in files.items():
        res = client.get(f"/admin/ai/_assets/{name}", headers={"cookie": cookie})
        assert res.status_code == 200, (name, res.text)
        ctype = res.headers["content-type"].split(";")[0]
        assert ctype == expected, (name, ctype)


# --- Auth/me firstName from session --------------------------------------


def test_auth_me_returns_first_name_field():
    """The bundled UI reads `user.firstName` from /api/auth/me. The
    Python SDK was returning "Default" hard-coded; this test pins
    that the shape stays intact regardless of how we resolve names."""
    client, cookie = _mk_app()
    res = client.get("/admin/ai/api/auth/me", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    body = res.json()
    assert "firstName" in body["user"], body
    assert body["user"]["role"] == "admin", body
