"""FastAPI integration — mounts the dashboard SPA + minimum API surface.

Mirrors `packages/sdk-ts/src/handler/routes.ts` for the v0 surface the SPA
actually uses: auth, samples list/detail/feedback, prompts (read-only),
version, github status (stub). The dashboard SPA bundle itself is loaded
from `gravel/packages/dashboard/dist/` on disk (resolved at router
construction; falls back to a JSON stub if the dist dir isn't present).
"""
from __future__ import annotations

import ipaddress
import json
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

from .auth import (
    SESSION_COOKIE,
    session_cookie_clear,
    session_cookie_value,
    sign_session,
    verify_password,
    verify_session,
)
from .dashboard_assets import find_dashboard_dist
from .db import open_database
from .samples_query import (
    get_sample_detail,
    gravel_tables_exist,
    list_samples,
    record_sample_feedback,
)
from .types import GravelConfig, resolve_config


def _client_host(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    return fwd.split(":")[0]


def _is_loopback(request: Request) -> bool:
    host = _client_host(request)
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _is_https(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    return proto == "https"


def _rewrite_shell(html: str, mount_path: str, product_name: str | None) -> str:
    prefix = mount_path.rstrip("/")

    def _replace(match: re.Match) -> str:
        attr, file = match.group(1), match.group(2)
        basename = file.split("/")[-1]
        return f'{attr}="{prefix}/_assets/{basename}"'

    rewritten = re.sub(r'(src|href)="\./assets/([^"]+)"', _replace, html)
    globals_js = [f"window.__GRAVEL_MOUNT_PATH__={json.dumps(prefix)}"]
    if product_name:
        globals_js.append(f"window.__GRAVEL_PRODUCT_NAME__={json.dumps(product_name)}")
    inject = f"<script>{';'.join(globals_js)}</script>"
    if '<script type="module"' in rewritten:
        return rewritten.replace(
            '<script type="module"', f'{inject}\n    <script type="module"', 1
        )
    return rewritten.replace("</head>", f"{inject}\n  </head>", 1)


def _authed_user(request: Request, password: str | None) -> dict | None:
    """Return a `{id, role, firstName}` dict if the request is authed, else None.

    Mirrors the JS SDK's localhostIsAdmin shortcut: requests against a
    loopback hostname are auto-admin so devs don't have to log in to view
    their own machine's traces.
    """
    if _is_loopback(request):
        return {"id": "localhost", "role": "admin", "firstName": "Developer"}
    if not password:
        return None
    cookie = request.cookies.get(SESSION_COOKIE)
    if cookie and verify_session(cookie, password):
        return {"id": "default", "role": "admin", "firstName": "Default"}
    return None


def create_gravel_router(config: GravelConfig, *, engine: Any = None) -> APIRouter:
    """Build the dashboard router.

    If `engine` is provided, the dashboard reads samples/feedback from it
    directly. Otherwise we open one from the config's `database.url`.
    Pass an explicit engine when the host app shares an in-memory DB
    with the tracer (demo mode, tests).

    A missing or empty `database.url` does NOT raise: the wizard's
    prompts-only / dashboard-only installs run without a DB at all,
    and the SDK serves auth + manifest + SPA routes regardless. The
    samples/feedback endpoints check the engine before issuing
    queries and return empty pages when it's None.
    """
    resolved = resolve_config(config)
    mount_path = resolved.mount_path.rstrip("/") or ""
    password = resolved.auth.get("default_password") if resolved.auth else None
    if engine is None:
        # Empty / missing URL is the prompts-only install case. Skip
        # opening anything; samples routes degrade to "no DB yet".
        db_url = resolved.database.get("url", "") if resolved.database else ""
        if db_url:
            engine = open_database(db_url)
    dist = find_dashboard_dist()
    shell_html = (dist / "index.html").read_text(encoding="utf-8") if dist else None
    assets_dir = (dist / "assets") if dist else None

    router = APIRouter()

    # ---------- Auth ----------

    @router.get("/api/auth/me")
    async def auth_me(request: Request) -> Response:
        user = _authed_user(request, password)
        if not user:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse(
            {
                "user": user,
                "productName": resolved.product_name,
                "mountPath": mount_path,
                "hideArtanisBranding": resolved.hide_artanis_branding,
            }
        )

    @router.post("/api/auth/login")
    async def auth_login(request: Request) -> Response:
        if not password:
            return JSONResponse({"error": "password mode not configured"}, status_code=400)
        ctype = request.headers.get("content-type", "")
        presented = ""
        if "application/x-www-form-urlencoded" in ctype:
            form = await request.form()
            presented = str(form.get("password") or "")
        else:
            try:
                body = await request.json()
                if isinstance(body, dict) and isinstance(body.get("password"), str):
                    presented = body["password"]
            except Exception:
                pass
        if not presented or not verify_password(presented, password):
            return JSONResponse({"error": "invalid password"}, status_code=401)
        cookie = sign_session(password)
        headers = {"set-cookie": session_cookie_value(cookie, https=_is_https(request))}
        return JSONResponse({"ok": True}, status_code=200, headers=headers)

    @router.post("/api/auth/logout")
    async def auth_logout(request: Request) -> Response:
        return JSONResponse(
            {"ok": True},
            headers={"set-cookie": session_cookie_clear(https=_is_https(request))},
        )

    # ---------- Version ----------

    @router.get("/api/version")
    async def version_info(request: Request) -> Response:
        user = _authed_user(request, password)
        if not user:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if user.get("role") != "admin":
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        from .version_check import get_version_info

        return JSONResponse(get_version_info())

    # ---------- Samples ----------

    def _empty_page() -> dict:
        return {"samples": [], "total": 0, "page": 1, "page_size": 20}

    @router.get("/api/samples")
    async def samples_list(
        request: Request,
        env: str | None = Query(default=None),
        model: str | None = Query(default=None),
        status: str | None = Query(default=None),
        q: str | None = Query(default=None),
        from_: str | None = Query(default=None, alias="from"),
        to: str | None = Query(default=None),
        page: int = Query(default=1),
        page_size: int = Query(default=20),
    ) -> Response:
        if not _authed_user(request, password):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not gravel_tables_exist(engine):
            return JSONResponse(_empty_page())
        result = list_samples(
            engine,
            env=env,
            model=model,
            status=status,
            q=q,
            from_=from_,
            to=to,
            page=page,
            page_size=page_size,
        )
        return JSONResponse(result)

    @router.get("/api/samples/{sample_id}")
    async def samples_detail(request: Request, sample_id: str) -> Response:
        if not _authed_user(request, password):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not gravel_tables_exist(engine):
            return JSONResponse({"error": "tables-missing"}, status_code=404)
        detail = get_sample_detail(engine, sample_id)
        if not detail:
            return JSONResponse({"error": "not-found"}, status_code=404)
        return JSONResponse(detail)

    @router.post("/api/samples/{sample_id}/feedback")
    async def samples_feedback(request: Request, sample_id: str) -> Response:
        user = _authed_user(request, password)
        if not user:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            body: Any = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        if not isinstance(body, dict):
            body = {}
        score = body.get("score") if body.get("score") in {"positive", "negative", "neutral"} else None
        comment = body.get("comment") if isinstance(body.get("comment"), str) else None
        correction = body.get("correction") if isinstance(body.get("correction"), str) else None
        result = record_sample_feedback(
            engine,
            sample_id=sample_id,
            score=score,
            comment=comment,
            correction=correction,
            reporter_user_id=user["id"],
        )
        return JSONResponse({"ok": True, "id": result["id"]})

    # ---------- Prompts (read-only, from manifest) ----------

    @router.get("/api/prompts")
    async def prompts_list(request: Request) -> Response:
        if not _authed_user(request, password):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        manifest_path = Path(".gravel/manifest.json")
        if not manifest_path.exists():
            return JSONResponse({"prompts": [], "last_scan_at": None})
        try:
            mf = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            return JSONResponse({"prompts": [], "last_scan_at": None})
        prompts = []
        for p in mf.get("prompts", []):
            preview = ""
            try:
                file_text = Path(p["path"]).read_text(encoding="utf-8")
                if p.get("type") == "embedded":
                    preview = file_text[p["charStart"] : p["charEnd"]].strip()[:280]
                else:
                    preview = file_text.strip()[:280]
            except Exception:
                pass
            prompts.append({**p, "preview": preview})
        return JSONResponse({"prompts": prompts, "last_scan_at": mf.get("lastFullScanAt")})

    @router.get("/api/prompts/{prompt_id}")
    async def prompts_detail(prompt_id: str, request: Request) -> Response:
        if not _authed_user(request, password):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not prompt_id:
            return JSONResponse({"error": "missing id"}, status_code=400)
        manifest_path = Path(".gravel/manifest.json")
        if not manifest_path.exists():
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            mf = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            return JSONResponse({"error": "not found"}, status_code=404)
        entry = next((p for p in mf.get("prompts", []) if p.get("id") == prompt_id), None)
        if entry is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            file_text = Path(entry["path"]).read_text(encoding="utf-8")
        except FileNotFoundError:
            return JSONResponse({"error": "source file missing"}, status_code=410)
        if entry.get("type") == "embedded":
            content = file_text[entry["charStart"] : entry["charEnd"]]
            return JSONResponse(
                {
                    "id": entry["id"],
                    "type": "embedded",
                    "path": entry["path"],
                    "varName": entry.get("varName"),
                    "content": content,
                }
            )
        return JSONResponse(
            {
                "id": entry["id"],
                "type": entry.get("type", "file"),
                "path": entry["path"],
                "content": file_text,
            }
        )

    # ---------- GitHub status (stub, no python-side install support yet) ----------

    @router.get("/api/github/status")
    async def github_status(request: Request) -> Response:
        if not _authed_user(request, password):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse({"connected": False, "repoOwner": None, "repoName": None})

    # ---------- Dashboard SPA shell + assets ----------

    def _serve_shell() -> Response:
        if shell_html is None:
            return JSONResponse(
                {
                    "error": "dashboard_dist_not_found",
                    "hint": (
                        "Set GRAVEL_DASHBOARD_DIST to the absolute path of "
                        "gravel/packages/dashboard/dist/, or build the JS dashboard."
                    ),
                },
                status_code=503,
            )
        return HTMLResponse(_rewrite_shell(shell_html, mount_path, resolved.product_name))

    @router.get("/")
    async def shell_root() -> Response:
        return _serve_shell()

    @router.get("/login")
    async def shell_login() -> Response:
        return _serve_shell()

    @router.get("/_assets/{filename}")
    async def asset(filename: str) -> Response:
        if not assets_dir or "/" in filename or ".." in filename:
            return JSONResponse({"error": "invalid asset name"}, status_code=400)
        target = assets_dir / filename
        if not target.exists():
            return JSONResponse({"error": "asset not found"}, status_code=404)
        ctype = (
            "application/javascript"
            if filename.endswith(".js")
            else "text/css"
            if filename.endswith(".css")
            else "application/octet-stream"
        )
        return Response(
            target.read_bytes(),
            media_type=ctype,
            headers={"cache-control": "public, max-age=31536000, immutable"},
        )

    # SPA client-side routes (e.g. /samples, /prompts/abc) — serve the
    # shell HTML for any unmatched GET so the SPA's router can take over.
    @router.get("/{full_path:path}")
    async def spa_fallthrough(full_path: str) -> Response:
        if full_path.startswith("api/") or full_path.startswith("_assets/"):
            return JSONResponse({"error": "not-found", "path": "/" + full_path}, status_code=404)
        return _serve_shell()

    return router
