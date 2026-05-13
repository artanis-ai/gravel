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


def _login(client) -> str:
    """Log in, return the auth cookie. Shared helper for the tests below."""
    login = client.post("/admin/ai/api/auth/login", json={"password": "test-password"})
    assert login.status_code == 200, login.text
    cookie = login.headers.get("set-cookie", "")
    assert cookie, "login did not set a session cookie"
    return cookie


def _build_client_with_manifest(tmp_path, monkeypatch, manifest_body: str | None) -> tuple:
    """Stand up a TestClient inside a tmp cwd, optionally with a .gravel/
    manifest.json. Returns (client, login_cookie)."""
    monkeypatch.chdir(tmp_path)
    if manifest_body is not None:
        (tmp_path / ".gravel").mkdir()
        (tmp_path / ".gravel" / "manifest.json").write_text(manifest_body, encoding="utf-8")
    app = FastAPI()
    app.include_router(create_gravel_router(_config_without_db()), prefix="/admin/ai")
    client = TestClient(app)
    return client, _login(client)


def test_prompts_detail_embedded_returns_sliced_content(tmp_path, monkeypatch):
    """REGRESSION: PromptDetail.tsx fetches /api/prompts/{id} and used to
    404 on the Python SDK because only the list endpoint was implemented.
    Embedded prompts (with charStart/charEnd) must return the slice."""
    src = "header line\nPROMPT BODY HERE\ntrailer\n"
    (tmp_path / "src.py").write_text(src, encoding="utf-8")
    cs = src.index("PROMPT BODY HERE")
    ce = cs + len("PROMPT BODY HERE")
    import json
    manifest = json.dumps({
        "version": 1,
        "prompts": [{
            "id": "p_abc123",
            "type": "embedded",
            "path": "src.py",
            "charStart": cs,
            "charEnd": ce,
            "lineStart": 2,
            "lineEnd": 2,
            "varName": "PROMPT",
            "hash": "deadbeef",
        }],
    })
    client, cookie = _build_client_with_manifest(tmp_path, monkeypatch, manifest)

    res = client.get("/admin/ai/api/prompts/p_abc123", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["id"] == "p_abc123"
    assert body["type"] == "embedded"
    assert body["path"] == "src.py"
    assert body["varName"] == "PROMPT"
    assert body["content"] == "PROMPT BODY HERE", body


def test_prompts_detail_file_returns_full_content(tmp_path, monkeypatch):
    """Whole-file prompts return the entire file body, no slicing."""
    text = "you are a helpful assistant\n"
    (tmp_path / "prompts" / "sys.md").parent.mkdir()
    (tmp_path / "prompts" / "sys.md").write_text(text, encoding="utf-8")
    import json
    manifest = json.dumps({
        "version": 1,
        "prompts": [{
            "id": "p_file001",
            "type": "file",
            "path": "prompts/sys.md",
            "hash": "0000",
        }],
    })
    client, cookie = _build_client_with_manifest(tmp_path, monkeypatch, manifest)

    res = client.get("/admin/ai/api/prompts/p_file001", headers={"cookie": cookie})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["type"] == "file"
    assert body["content"] == text


def test_prompts_detail_unknown_id_404(tmp_path, monkeypatch):
    import json
    manifest = json.dumps({"version": 1, "prompts": []})
    client, cookie = _build_client_with_manifest(tmp_path, monkeypatch, manifest)
    res = client.get("/admin/ai/api/prompts/p_doesnt_exist", headers={"cookie": cookie})
    assert res.status_code == 404, res.text


def test_prompts_detail_no_manifest_404(tmp_path, monkeypatch):
    """No manifest file at all (prompts-only install pre-init): 404, not 500."""
    client, cookie = _build_client_with_manifest(tmp_path, monkeypatch, None)
    res = client.get("/admin/ai/api/prompts/p_anything", headers={"cookie": cookie})
    assert res.status_code == 404, res.text


def test_prompts_detail_missing_source_file_410(tmp_path, monkeypatch):
    """Manifest references a file that's since been deleted: 410 Gone,
    not a 500 ImportError or a misleading 404."""
    import json
    manifest = json.dumps({
        "version": 1,
        "prompts": [{"id": "p_gone", "type": "file", "path": "deleted.md", "hash": "0"}],
    })
    client, cookie = _build_client_with_manifest(tmp_path, monkeypatch, manifest)
    res = client.get("/admin/ai/api/prompts/p_gone", headers={"cookie": cookie})
    assert res.status_code == 410, res.text


def test_prompts_detail_unauthenticated_401(tmp_path, monkeypatch):
    """No cookie: 401, never 404, so callers can distinguish missing-auth
    from missing-prompt."""
    monkeypatch.chdir(tmp_path)
    app = FastAPI()
    app.include_router(create_gravel_router(_config_without_db()), prefix="/admin/ai")
    client = TestClient(app)
    res = client.get("/admin/ai/api/prompts/p_whatever")
    assert res.status_code == 401, res.text


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
