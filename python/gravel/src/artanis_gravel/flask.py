"""Flask integration.

Usage (single line in the host's entry, after `app = Flask(__name__)`):

    from artanis_gravel.flask import mount_on_flask
    from gravel_config import config

    mount_on_flask(app, config)

What this does:

  * Stands up the FastAPI dashboard app from `artanis_gravel.fastapi` —
    same code path FastAPI customers hit, so the dashboard, auth, and
    every API route are bit-for-bit identical across Python frameworks.
  * Wraps that FastAPI (ASGI) app via `a2wsgi.ASGIMiddleware` — the
    standard ASGI→WSGI bridge. (asgiref's `WsgiToAsgi` goes the OTHER
    way; ASGI→WSGI was never added to asgiref because ASGI features
    like websockets / chunked streaming don't have clean WSGI analogues.
    a2wsgi handles the synchronous request/response path we care about,
    which is everything the dashboard needs.)
  * Mounts the wrapped WSGI app on the Flask app's `wsgi_app` chain via
    `werkzeug.middleware.dispatcher.DispatcherMiddleware`, scoped to
    `config.mount_path`. Flask continues to serve everything outside the
    mount path; the dashboard intercepts inside it.

Why one line in the host: every framework-specific concern lives in the
SDK. The customer's Flask app neither imports FastAPI / Werkzeug
internals nor knows about a2wsgi. If we change the bridge mechanism
later, the host doesn't have to know.

Optional install — `pip install artanis-gravel[flask]` (or `uv add
artanis-gravel[flask]`) pulls in the a2wsgi runtime dep. Without
the extra, importing this module raises a clear ImportError pointing
the user at the install command.
"""
from __future__ import annotations

from typing import Any

from .types import GravelConfig, resolve_config


def mount_on_flask(flask_app: Any, config: GravelConfig) -> None:
    """Mount the Gravel dashboard inside an existing Flask app at
    `config.mount_path`.

    The argument is the Flask app instance, not a Blueprint or a
    WSGI callable. We mutate `flask_app.wsgi_app` in place — the
    canonical Werkzeug pattern for adding middleware to a Flask app.

    Re-mounting (calling twice) is supported: each call wraps the
    current wsgi_app, so the most recent mount wins for the prefix.
    Customers re-running `gravel init` won't double-mount because the
    wizard's idempotency check on the entry file's import line
    prevents a second `mount_on_flask` call from being inserted.
    """
    try:
        from a2wsgi import ASGIMiddleware
    except ImportError as e:
        raise ImportError(
            "artanis_gravel.flask requires a2wsgi (the ASGI→WSGI bridge). "
            "Install with:\n"
            "    pip install 'artanis-gravel[flask]'\n"
            "or:\n"
            "    uv add 'artanis-gravel[flask]'"
        ) from e
    try:
        from werkzeug.middleware.dispatcher import DispatcherMiddleware
    except ImportError as e:
        raise ImportError(
            "artanis_gravel.flask needs Werkzeug, which ships with Flask. "
            "Is Flask installed?"
        ) from e
    try:
        from fastapi import FastAPI
    except ImportError as e:
        raise ImportError(
            "artanis_gravel.flask reuses the FastAPI dashboard internally "
            "for code-reuse across Python frameworks. Install with:\n"
            "    pip install 'artanis-gravel[flask]'\n"
            "(the [flask] extra pulls in both asgiref and fastapi)"
        ) from e
    # Defer the heavy import until we know the deps are present.
    from .fastapi import create_gravel_router

    resolved = resolve_config(config)
    prefix = resolved.mount_path.rstrip("/") or "/admin/ai"

    # Stand up a fresh FastAPI app and mount the gravel router at /.
    # We don't use a prefix on the FastAPI side because the dispatcher
    # middleware already strips the prefix from the WSGI request before
    # forwarding — the gravel router sees paths like /api/auth/me,
    # exactly the way the standalone FastAPI integration does.
    inner = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    inner.include_router(create_gravel_router(config))

    # DispatcherMiddleware's signature: (default, {prefix: app}).
    # Requests whose path starts with `prefix` go to our app (with the
    # prefix stripped); everything else goes to the user's existing
    # Flask wsgi_app.
    flask_app.wsgi_app = DispatcherMiddleware(
        flask_app.wsgi_app,
        {prefix: ASGIMiddleware(inner)},
    )
