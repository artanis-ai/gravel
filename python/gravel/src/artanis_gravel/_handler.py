"""Framework-agnostic dashboard handler.

Shared core that the FastAPI, ASGI, WSGI, and Django integrations all
delegate to. Mirrors `packages/sdk-ts/src/handler/routes.ts` route by
route, so a host that switches between the Python and TS SDKs sees the
same dashboard behaviour byte-for-byte.

Why a single handler instead of per-framework route tables:

  * `asgi.py` and `django.py` previously shipped placeholders ("blocker:
    full route table lands alongside v0 build") because the FastAPI
    surface had drifted into framework-specific helpers. Going through
    `dispatch_request()` here means there is exactly ONE place to add a
    route, and every integration gets it for free.
  * Each integration converts its native request representation to a
    small dataclass and back. The conversion is the only framework-
    specific code; everything else (auth, manifest reads, GitHub API,
    PR creation) is pure Python.

The output of every handler is a `HandlerResponse` containing status,
headers, and body bytes. Integrations adapt that to their framework's
response type (FastAPI's `Response`, Django's `HttpResponse`, the raw
ASGI `http.response.*` events, or WSGI's `start_response` tuple).
"""
from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs

from ._env_writer import write_env_additions
from ._github_state import (
    GhInstallState,
    get_gh_install_state,
    mint_installation_token_via_cp,
)
from ._migrations_status import migrations_status
from ._prompts_submit import DraftInput, SubmitArgs, SubmitError, draft_branch_for, submit_drafts
from ._rate_limit import attempt_login, record_success
from .auth import (
    SESSION_COOKIE,
    SESSION_TTL_S,
    session_cookie_clear,
    session_cookie_value,
    sign_session,
    verify_password,
    verify_session,
)
from .manifest.io import _prompt_to_dict, read_manifest
from .manifest.types import ManifestPromptEmbedded
from .types import ResolvedGravelConfig
from .version_check import get_version_info

VIEW_AS_COOKIE = "gravel_view_as"


# -------------------- I/O dataclasses --------------------


@dataclass
class HandlerRequest:
    """Framework-agnostic request view. Each integration builds one of
    these from its native request and passes it to `dispatch_request`."""
    method: str
    path: str
    query_string: str
    headers: dict[str, str]
    cookies: dict[str, str]
    body: bytes
    url: str  # full URL incl. scheme; used for Set-Cookie Secure detection
    scheme: str


@dataclass
class HandlerResponse:
    """Framework-agnostic response. `headers` may contain multiple
    set-cookie entries, so we use a list of (k, v) pairs rather than a
    dict to preserve duplicates."""
    status: int
    headers: list[tuple[str, str]]
    body: bytes


# -------------------- Helpers --------------------


def _json_response(data: Any, status: int = 200, headers: list[tuple[str, str]] | None = None) -> HandlerResponse:
    h: list[tuple[str, str]] = [("content-type", "application/json")]
    if headers:
        h.extend(headers)
    return HandlerResponse(status=status, headers=h, body=json.dumps(data).encode("utf-8"))


def _client_host(req: HandlerRequest) -> str:
    fwd = req.headers.get("x-forwarded-host") or req.headers.get("host", "")
    return fwd.split(":")[0]


def _is_loopback(req: HandlerRequest) -> bool:
    host = _client_host(req)
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _is_https(req: HandlerRequest) -> bool:
    proto = req.headers.get("x-forwarded-proto") or req.scheme
    return proto == "https"


def _client_ip(req: HandlerRequest) -> str:
    """Best-effort source IP. Honors X-Forwarded-For (first hop) then
    X-Real-IP; same precedence as the TS handler so rate-limiting agrees
    across SDKs sitting behind the same proxy."""
    xff = req.headers.get("x-forwarded-for", "")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    return req.headers.get("x-real-ip") or "unknown"


def _parse_form(body: bytes) -> dict[str, str]:
    raw = body.decode("utf-8", errors="replace")
    parsed = parse_qs(raw, keep_blank_values=True)
    return {k: v[0] for k, v in parsed.items() if v}


def _parse_json(body: bytes) -> Any:
    if not body:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except Exception:
        return None


def _view_as_cookie_value(value: str, *, https: bool) -> str:
    parts = [f"{VIEW_AS_COOKIE}={value}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={SESSION_TTL_S}"]
    if https:
        parts.append("Secure")
    return "; ".join(parts)


def _view_as_cookie_clear(*, https: bool) -> str:
    parts = [f"{VIEW_AS_COOKIE}=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]
    if https:
        parts.append("Secure")
    return "; ".join(parts)


def _repo_root() -> str:
    """Where we read the manifest + prompt files from. Honors
    `GRAVEL_REPO_ROOT` so a dev running the dashboard's HMR Vite server
    (whose cwd is `packages/dashboard`) can point it at their actual
    app's repo root and see real prompts. In production, this is the
    user's app cwd."""
    import os

    return os.environ.get("GRAVEL_REPO_ROOT") or os.getcwd()


# -------------------- Auth + session --------------------


@dataclass
class AuthedUser:
    id: str
    role: str
    first_name: str


def _authed_user(req: HandlerRequest, password: str | None) -> AuthedUser | None:
    """Resolve the current user. Loopback hostnames are auto-admin
    so devs don't have to log in to view their own machine's traces
    (matches the JS SDK's localhost-is-admin shortcut)."""
    if _is_loopback(req):
        return AuthedUser(id="localhost", role="admin", first_name="Developer")
    if not password:
        return None
    cookie = req.cookies.get(SESSION_COOKIE)
    if cookie and verify_session(cookie, password):
        return AuthedUser(id="default", role="admin", first_name="Default")
    return None


# -------------------- Dashboard shell --------------------


def _rewrite_shell(html: str, mount_path: str, resolved: ResolvedGravelConfig) -> str:
    """Drop the dashboard's relative asset URLs onto the SDK mount
    path and inject the SPA's bootstrap globals. Identical algorithm
    to TS `rewriteShell` in handler/routes.ts."""
    prefix = mount_path.rstrip("/")

    def _replace(m: re.Match) -> str:
        attr, file = m.group(1), m.group(2)
        return f'{attr}="{prefix}/_assets/{file.split("/")[-1]}"'

    rewritten = re.sub(r'(src|href)="\./assets/([^"]+)"', _replace, html)
    globals_js = [
        f"window.__GRAVEL_MOUNT_PATH__={json.dumps(prefix)}",
        'window.__GRAVEL_RUNTIME__="python"',
    ]
    if resolved.product_name:
        globals_js.append(f"window.__GRAVEL_PRODUCT_NAME__={json.dumps(resolved.product_name)}")
    if resolved.hide_artanis_branding:
        globals_js.append("window.__GRAVEL_HIDE_ARTANIS__=true")
    inject = f"<script>{';'.join(globals_js)}</script>"
    if '<script type="module"' in rewritten:
        return rewritten.replace('<script type="module"', f'{inject}\n    <script type="module"', 1)
    return rewritten.replace("</head>", f"{inject}\n  </head>", 1)


# Asset content-type map. Mirrors packages/sdk-ts/src/handler/dashboard-bundle.ts.
_ASSET_CONTENT_TYPES = {
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".map": "application/json",
    ".json": "application/json",
    ".wasm": "application/wasm",
}


def _content_type_for(filename: str) -> str:
    for ext, ctype in _ASSET_CONTENT_TYPES.items():
        if filename.endswith(ext):
            return ctype
    return "application/octet-stream"


# -------------------- Route handlers --------------------


@dataclass
class Context:
    config: ResolvedGravelConfig
    engine: Any  # SQLAlchemy Engine | None
    password: str | None
    shell_html: str | None
    assets_dir: Path | None
    mount_path: str
    # Authed user resolved by dispatch_request once per call.
    user: AuthedUser | None = None
    # Path scoped to whatever lives under mount_path (no prefix).
    sub_path: str = ""
    # Set by dispatch_request when the full url is available.
    request: HandlerRequest = field(default=None)  # type: ignore[assignment]


def _serve_shell(ctx: Context) -> HandlerResponse:
    if ctx.shell_html is None:
        return _json_response(
            {
                "error": "dashboard_dist_not_found",
                "hint": (
                    "Set GRAVEL_DASHBOARD_DIST to the absolute path of "
                    "gravel/packages/dashboard/dist/, or build the JS dashboard."
                ),
            },
            status=503,
        )
    html = _rewrite_shell(ctx.shell_html, ctx.mount_path, ctx.config).encode("utf-8")
    return HandlerResponse(
        status=200,
        headers=[("content-type", "text/html; charset=utf-8"), ("cache-control", "no-cache")],
        body=html,
    )


def _auth_me(ctx: Context) -> HandlerResponse:
    u = ctx.user
    if not u:
        return _json_response({"error": "unauthorized"}, 401)
    return _json_response(
        {
            "user": {"id": u.id, "role": u.role, "firstName": u.first_name},
            "productName": ctx.config.product_name,
            "mountPath": ctx.mount_path,
            "hideArtanisBranding": ctx.config.hide_artanis_branding,
        }
    )


def _auth_login(ctx: Context) -> HandlerResponse:
    req = ctx.request
    if not ctx.password:
        return _json_response({"error": "password mode not configured"}, 400)

    ctype = req.headers.get("content-type", "")
    is_form = "application/x-www-form-urlencoded" in ctype
    presented = ""
    if is_form:
        presented = _parse_form(req.body).get("password", "")
    else:
        body = _parse_json(req.body)
        if isinstance(body, dict) and isinstance(body.get("password"), str):
            presented = body["password"]

    ip = _client_ip(req)
    rate = attempt_login(ip)
    if not rate.allowed:
        return _json_response(
            {"error": "too many attempts", "retry_after_ms": rate.retry_after_ms or 60_000},
            429,
        )

    if not presented or not verify_password(presented, ctx.password):
        if is_form:
            return HandlerResponse(
                status=303,
                headers=[("location", f"{ctx.mount_path}/login?error=1")],
                body=b"",
            )
        return _json_response({"error": "invalid password"}, 401)

    record_success(ip)
    cookie = sign_session(ctx.password)
    set_cookie = session_cookie_value(cookie, https=_is_https(req))
    if is_form:
        # Trailing slash matters: the SPA shell's relative asset URLs
        # resolve against the directory of the URL. `/admin/ai` (no
        # slash) resolves `./assets/x.js` to `/admin/assets/x.js` which
        # is wrong.
        return HandlerResponse(
            status=303,
            headers=[
                ("set-cookie", set_cookie),
                ("location", f"{ctx.mount_path or ''}/"),
            ],
            body=b"",
        )
    return _json_response({"ok": True}, headers=[("set-cookie", set_cookie)])


def _auth_logout(ctx: Context) -> HandlerResponse:
    set_cookie = session_cookie_clear(https=_is_https(ctx.request))
    return HandlerResponse(
        status=303,
        headers=[("set-cookie", set_cookie), ("location", f"{ctx.mount_path}/login")],
        body=b"",
    )


def _auth_view_as(ctx: Context) -> HandlerResponse:
    if not ctx.user:
        return _json_response({"error": "unauthorized"}, 401)
    if ctx.user.role != "admin":
        return _json_response({"error": "admin only"}, 403)
    body = _parse_json(ctx.request.body)
    mode = body.get("mode") if isinstance(body, dict) else None
    https = _is_https(ctx.request)
    if mode == "user":
        set_cookie = _view_as_cookie_value("user", https=https)
        view_as: str | None = "user"
    else:
        set_cookie = _view_as_cookie_clear(https=https)
        view_as = None
    return _json_response(
        {"ok": True, "view_as": view_as},
        headers=[("set-cookie", set_cookie)],
    )


def _version(ctx: Context) -> HandlerResponse:
    if not ctx.user or ctx.user.role != "admin":
        return _json_response({"error": "unauthorized"}, 401)
    return _json_response(get_version_info())


def _migrations_status(ctx: Context) -> HandlerResponse:
    if not ctx.user or ctx.user.role != "admin":
        return _json_response({"error": "unauthorized"}, 401)
    return _json_response(migrations_status(ctx.engine))


def _prompts_list(ctx: Context) -> HandlerResponse:
    if not ctx.user:
        return _json_response({"error": "unauthorized"}, 401)
    try:
        manifest = read_manifest(_repo_root())
    except Exception:
        return _json_response({"prompts": [], "last_scan_at": None})

    # Ask git once which of the manifest's paths haven't reached the
    # upstream branch yet. Empty set on any git failure → all prompts
    # appear "pushed" and the dashboard surface is unchanged.
    from ._push_status import unpushed_paths

    paths = [p.path for p in manifest.prompts]
    unpushed = unpushed_paths(_repo_root(), paths)

    out: list[dict] = []
    for p in manifest.prompts:
        preview = ""
        try:
            full = (Path(_repo_root()) / p.path).read_text(encoding="utf-8")
            if isinstance(p, ManifestPromptEmbedded):
                preview = full[p.char_start : p.char_end].strip()[:280]
            else:
                preview = full.strip()[:280]
        except Exception:
            pass
        out.append({
            **_prompt_to_dict(p),
            "preview": preview,
            "pushed": p.path not in unpushed,
        })
    return _json_response({"prompts": out, "last_scan_at": manifest.last_full_scan_at})


def _prompts_detail(ctx: Context, prompt_id: str) -> HandlerResponse:
    if not ctx.user:
        return _json_response({"error": "unauthorized"}, 401)
    if not prompt_id:
        return _json_response({"error": "missing id"}, 400)
    try:
        manifest = read_manifest(_repo_root())
    except Exception:
        return _json_response({"error": "not found"}, 404)
    entry = next((p for p in manifest.prompts if p.id == prompt_id), None)
    if entry is None:
        return _json_response({"error": "not found"}, 404)
    try:
        full = (Path(_repo_root()) / entry.path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return _json_response({"error": "source file missing"}, 410)
    if isinstance(entry, ManifestPromptEmbedded):
        return _json_response(
            {
                "id": entry.id,
                "type": "embedded",
                "path": entry.path,
                "varName": entry.var_name,
                "content": full[entry.char_start : entry.char_end],
            }
        )
    return _json_response(
        {"id": entry.id, "type": "file", "path": entry.path, "content": full}
    )


def _prompts_submit(ctx: Context) -> HandlerResponse:
    if not ctx.user:
        return _json_response({"error": "unauthorized"}, 401)
    body = _parse_json(ctx.request.body)
    if not isinstance(body, dict):
        body = {}
    raw_drafts = body.get("drafts")
    if not isinstance(raw_drafts, list) or not raw_drafts:
        return _json_response(
            {"error": "no_drafts", "message": "drafts (non-empty array) required in request body"},
            400,
        )
    drafts: list[DraftInput] = []
    for raw in raw_drafts:
        if (
            not isinstance(raw, dict)
            or not isinstance(raw.get("promptId"), str)
            or not isinstance(raw.get("newText"), str)
        ):
            return _json_response(
                {"error": "invalid_draft", "message": "each draft needs string promptId + newText"},
                400,
            )
        drafts.append(DraftInput(prompt_id=raw["promptId"], new_text=raw["newText"]))

    state = get_gh_install_state()
    if state is None:
        return _json_response(
            {
                "error": "github_not_installed",
                "message": (
                    "Gravel GitHub App is not installed on this project. "
                    "Ask your developer to install it from the dashboard."
                ),
            },
            409,
        )

    try:
        token = mint_installation_token_via_cp(state)
    except RuntimeError as e:
        return _json_response(
            {"error": "github_token_mint_failed", "message": str(e)}, 502
        )

    title = body.get("title") if isinstance(body.get("title"), str) else None
    description = body.get("description") if isinstance(body.get("description"), str) else None
    submitter_name = body.get("submitterName") if isinstance(body.get("submitterName"), str) else None
    submitter = (submitter_name.strip() if submitter_name else "") or ctx.user.first_name

    try:
        result = submit_drafts(
            SubmitArgs(
                repo_root=_repo_root(),
                drafts=drafts,
                draft_branch=draft_branch_for(ctx.user.id),
                access_token=token.token,
                repo_owner=state.repo_owner,
                repo_name=state.repo_name,
                title=title,
                description=description,
                de_first_name=submitter,
            )
        )
        return _json_response(
            {
                "ok": True,
                "pr": {
                    "prUrl": result.pr_url,
                    "prNumber": result.pr_number,
                    "branchName": result.branch_name,
                },
            }
        )
    except SubmitError as e:
        return _json_response(
            {"error": e.code, "message": str(e), "details": e.details}, 400
        )


def _github_status(ctx: Context) -> HandlerResponse:
    if not ctx.user:
        return _json_response({"error": "unauthorized"}, 401)
    state: GhInstallState | None = get_gh_install_state()
    return _json_response(
        {
            "connected": state is not None,
            "repoOwner": state.repo_owner if state else None,
            "repoName": state.repo_name if state else None,
        }
    )


def _github_install(ctx: Context) -> HandlerResponse:
    """Kick off the GH App install flow. In dev (`GRAVEL_GH_DEV_STUB=1`)
    we bypass the CP and return a redirect straight at our own
    callback so UI iteration doesn't need a deployed control plane."""
    import os

    callback = f"{ctx.request.scheme}://{ctx.request.headers.get('host', '')}{ctx.mount_path}/api/github/install/callback"
    if os.environ.get("GRAVEL_GH_DEV_STUB") == "1":
        owner = os.environ.get("GRAVEL_GH_DEV_REPO_OWNER")
        name = os.environ.get("GRAVEL_GH_DEV_REPO_NAME")
        if not owner or not name:
            return _json_response(
                {
                    "error": "GRAVEL_GH_DEV_STUB=1 requires GRAVEL_GH_DEV_REPO_OWNER + GRAVEL_GH_DEV_REPO_NAME"
                },
                500,
            )
        return _json_response({"redirectUrl": f"{callback}?gh=installed"})
    cp = os.environ.get("GRAVEL_CONTROL_PLANE_URL") or "https://gravel.artanis.ai"
    start = cp.rstrip("/") + "/api/cli/github/install/start"
    from urllib.parse import quote

    from ._repo_detect import detect_local_github_repo

    url = f"{start}?return_to={quote(callback, safe='')}"
    # Best-effort: pass `expected_repo` so the CP picks the right repo
    # if the install covers multiple. Detection from git remote; falls
    # back to "no hint" if anything goes wrong (CP picks first repo).
    local = detect_local_github_repo()
    if local:
        owner, name = local
        url += f"&expected_repo={quote(f'{owner}/{name}', safe='')}"
    return _json_response({"redirectUrl": url})


def _github_install_callback(ctx: Context) -> HandlerResponse:
    import os

    params = parse_qs(ctx.request.query_string, keep_blank_values=True)
    installation_id = (params.get("installation_id") or [""])[0]
    install_secret = (params.get("install_secret") or [""])[0]
    repo_owner = (params.get("repo_owner") or [""])[0]
    repo_name = (params.get("repo_name") or [""])[0]
    if installation_id and install_secret and repo_owner and repo_name:
        try:
            write_env_additions(
                os.getcwd(),
                {
                    "GRAVEL_GH_INSTALL_ID": installation_id,
                    "GRAVEL_GH_INSTALL_SECRET": install_secret,
                    "GRAVEL_GH_REPO_OWNER": repo_owner,
                    "GRAVEL_GH_REPO_NAME": repo_name,
                },
                overwrite=True,
            )
            # Make the env vars visible to subsequent requests in this
            # process without restart.
            os.environ["GRAVEL_GH_INSTALL_ID"] = installation_id
            os.environ["GRAVEL_GH_INSTALL_SECRET"] = install_secret
            os.environ["GRAVEL_GH_REPO_OWNER"] = repo_owner
            os.environ["GRAVEL_GH_REPO_NAME"] = repo_name
        except Exception as e:
            # Surface as a clean redirect; dashboard's "App not installed"
            # state covers the failure UI.
            print(f"[gravel] failed to write GH install env vars: {e}")
    return HandlerResponse(
        status=302,
        headers=[("location", f"{ctx.mount_path}/?gh=installed")],
        body=b"",
    )


def _samples_list(ctx: Context) -> HandlerResponse:
    if not ctx.user:
        return _json_response({"error": "unauthorized"}, 401)
    from .samples_query import gravel_tables_exist, list_samples

    if not gravel_tables_exist(ctx.engine):
        return _json_response({"samples": [], "total": 0, "page": 1, "page_size": 20})
    qs = parse_qs(ctx.request.query_string, keep_blank_values=False)

    def _q(k: str) -> str | None:
        v = qs.get(k)
        return v[0] if v else None

    def _qint(k: str, default: int) -> int:
        v = _q(k)
        if v is None:
            return default
        try:
            return int(v)
        except ValueError:
            return default

    return _json_response(
        list_samples(
            ctx.engine,
            env=_q("env"),
            model=_q("model"),
            status=_q("status"),
            q=_q("q"),
            from_=_q("from"),
            to=_q("to"),
            page=_qint("page", 1),
            page_size=_qint("page_size", 20),
        )
    )


def _samples_detail(ctx: Context, sample_id: str) -> HandlerResponse:
    if not ctx.user:
        return _json_response({"error": "unauthorized"}, 401)
    from .samples_query import get_sample_detail, gravel_tables_exist

    if not gravel_tables_exist(ctx.engine):
        return _json_response({"error": "tables-missing"}, 404)
    detail = get_sample_detail(ctx.engine, sample_id)
    if not detail:
        return _json_response({"error": "not-found"}, 404)
    return _json_response(detail)


def _samples_feedback(ctx: Context, sample_id: str) -> HandlerResponse:
    if not ctx.user:
        return _json_response({"error": "unauthorized"}, 401)
    if not ctx.engine:
        return _json_response({"error": "tables-missing"}, 503)
    body = _parse_json(ctx.request.body)
    if not isinstance(body, dict):
        return _json_response({"error": "invalid JSON body"}, 400)
    from .samples_query import record_sample_feedback

    score = body.get("score") if body.get("score") in {"positive", "negative", "neutral"} else None
    result = record_sample_feedback(
        ctx.engine,
        sample_id=sample_id,
        score=score,
        comment=body.get("comment") if isinstance(body.get("comment"), str) else None,
        correction=body.get("correction") if isinstance(body.get("correction"), str) else None,
        reporter_user_id=ctx.user.id,
    )
    return _json_response({"ok": True, "id": result["id"]})


def _asset(ctx: Context, filename: str) -> HandlerResponse:
    if not ctx.assets_dir or "/" in filename or ".." in filename or not filename:
        return _json_response({"error": "invalid asset name"}, 400)
    target = ctx.assets_dir / filename
    if not target.exists():
        return _json_response({"error": "asset not found", "filename": filename}, 404)
    return HandlerResponse(
        status=200,
        headers=[
            ("content-type", _content_type_for(filename)),
            ("cache-control", "public, max-age=31536000, immutable"),
            ("content-length", str(target.stat().st_size)),
        ],
        body=target.read_bytes(),
    )


# -------------------- Dispatch table --------------------


# Each route value is one of:
#   (handler_fn,)              - method+path matched exactly
#   (handler_fn, "param_name") - path is a prefix; last segment is captured
#
# Static-method dispatch table; the order matters only for the
# prefix-style routes (they're matched after exact ones).
_EXACT_ROUTES: dict[tuple[str, str], Callable[[Context], HandlerResponse]] = {
    ("GET", "/api/auth/me"): _auth_me,
    ("POST", "/api/auth/login"): _auth_login,
    ("POST", "/api/auth/logout"): _auth_logout,
    ("POST", "/api/auth/view-as"): _auth_view_as,
    ("GET", "/api/version"): _version,
    ("GET", "/api/migrations/status"): _migrations_status,
    ("GET", "/api/prompts"): _prompts_list,
    ("POST", "/api/prompts/submit"): _prompts_submit,
    ("GET", "/api/github/status"): _github_status,
    ("GET", "/api/github/install"): _github_install,
    ("GET", "/api/github/install/callback"): _github_install_callback,
    ("GET", "/api/samples"): _samples_list,
    ("GET", "/"): _serve_shell,
    ("GET", "/login"): _serve_shell,
}


def _match_prefix(method: str, path: str) -> tuple[Callable, str] | None:
    """The handful of routes that need a single path-param (the last
    segment). Keeps the table above small and lets us share dispatch
    across integrations without a regex library."""
    if method == "GET" and path.startswith("/api/prompts/") and path != "/api/prompts/submit":
        return _prompts_detail, path[len("/api/prompts/") :]
    if method == "GET" and path.startswith("/api/samples/"):
        rest = path[len("/api/samples/") :]
        if "/" not in rest:
            return _samples_detail, rest
    if method == "POST" and path.startswith("/api/samples/") and path.endswith("/feedback"):
        sample = path[len("/api/samples/") : -len("/feedback")]
        if "/" not in sample:
            return _samples_feedback, sample
    if method == "GET" and path.startswith("/_assets/"):
        rest = path[len("/_assets/") :]
        if "/" not in rest:
            return _asset, rest
    return None


def dispatch_request(req: HandlerRequest, ctx: Context) -> HandlerResponse:
    """Single entry point every integration calls. `ctx` carries the
    config + engine + dashboard dist; we attach the request + user."""
    ctx.request = req
    ctx.user = _authed_user(req, ctx.password)

    # Normalise the path: strip a trailing slash on api routes so
    # /api/foo/ and /api/foo are equivalent (matches TS matchPath).
    path = req.sub_path if hasattr(req, "sub_path") else req.path
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    if not path.startswith("/"):
        path = "/" + path

    handler = _EXACT_ROUTES.get((req.method, path))
    if handler is not None:
        return handler(ctx)

    captured = _match_prefix(req.method, path)
    if captured is not None:
        fn, param = captured
        from urllib.parse import unquote

        return fn(ctx, unquote(param))

    # SPA fallthrough: any unmatched GET that isn't /api/ or /_assets/
    # serves the dashboard shell so the SPA's hash-router can take over.
    if (
        req.method == "GET"
        and not path.startswith("/api/")
        and not path.startswith("/_assets/")
    ):
        return _serve_shell(ctx)

    return _json_response({"error": "not-found", "path": path}, 404)


# -------------------- Public helpers used by integrations --------------------


def parse_cookies(header: str) -> dict[str, str]:
    """Tiny cookie-header parser. Avoids depending on http.cookies which
    is strict about reserved names and slow to import. The wire format
    is `k1=v1; k2=v2` per RFC 6265."""
    out: dict[str, str] = {}
    if not header:
        return out
    for chunk in header.split(";"):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def build_request_from_components(
    method: str,
    path: str,
    query_string: str,
    headers: dict[str, str],
    body: bytes,
    url: str,
    scheme: str,
) -> HandlerRequest:
    """Common builder used by FastAPI/Django/ASGI/WSGI integrations.
    Parses the cookie header into a dict so the handler doesn't have to
    repeat that work per request."""
    return HandlerRequest(
        method=method,
        path=path,
        query_string=query_string,
        headers={k.lower(): v for k, v in headers.items()},
        cookies=parse_cookies(headers.get("cookie") or headers.get("Cookie") or ""),
        body=body,
        url=url,
        scheme=scheme,
    )
