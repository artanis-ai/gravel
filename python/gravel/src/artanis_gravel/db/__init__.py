"""DB connector — SQLAlchemy. Engine for Postgres or SQLite based on URL.

Mirrors packages/sdk-ts/src/db/index.ts.
"""
from __future__ import annotations

import sys

from sqlalchemy import Engine, create_engine


def detect_dialect(url: str) -> str:
    if url.startswith(("postgres://", "postgresql://")):
        return "postgres"
    if url.startswith(("sqlite:", "file:")) or url.endswith((".db", ".sqlite")):
        return "sqlite"
    raise ValueError(
        f"[gravel] Unsupported DATABASE_URL: {url}. Use postgresql:// or sqlite:/file:."
    )


def open_database(url: str) -> Engine:
    dialect = detect_dialect(url)
    if dialect == "postgres":
        # Normalize the legacy postgres:// scheme to postgresql:// for SQLAlchemy.
        if url.startswith("postgres://"):
            url = "postgresql://" + url[len("postgres://"):]
        return create_engine(url, pool_pre_ping=True)
    if dialect == "sqlite":
        path = url.replace("file:", "").replace("sqlite:", "")
        engine = create_engine(f"sqlite:///{path}")
        return engine
    raise AssertionError("unreachable")


def try_open_database(url: str) -> Engine | None:
    """Open the database, never raising.

    The framework integrations call this at router-build time. Pre-v0.9.1
    they called the bare `open_database(url)` directly — if the driver
    was missing (`psycopg2` not installed for a `postgresql://` URL,
    say) the `create_engine`'s lazy driver import raised at the FIRST
    real call, but importing the engine itself was fine. With newer
    SQLAlchemy versions the import error fires immediately when the
    URL string is parsed, which crashed the host app on boot.
    Claude's de_platform install (2026-05-20) hit this — the whole
    FastAPI app failed to import because `psycopg2` wasn't there, and
    the user saw no logs in `uvicorn --reload`'s zombie last-good-build.

    Now we catch ImportError / ModuleNotFoundError / NoSuchModuleError
    (SQLAlchemy raises this when a dialect's driver isn't installed)
    and degrade to engine=None with a clear stderr message. The
    dashboard SPA still renders, samples routes return empty pages,
    and the user gets a directly-actionable line in their log.

    Genuine connect failures (bad credentials, DB unreachable) still
    surface — those happen at first query time, not at engine
    construction, and the persister's silent-fail-and-discard handles
    them per the tracing contract.
    """
    try:
        return open_database(url)
    except ModuleNotFoundError as exc:
        # `psycopg2` missing for a `postgresql://` URL is the
        # archetypal case. Print the actionable upgrade and continue.
        _print_driver_warning(url, str(exc))
        return None
    except ImportError as exc:
        _print_driver_warning(url, str(exc))
        return None
    except ValueError as exc:
        # detect_dialect raises ValueError for unrecognised URL schemes
        # (typo'd `posgresql://`, malformed URL string, etc.). Wizard-
        # generated configs don't hit this, but hand-edited ones can.
        # Degrade rather than crash boot.
        _print_driver_warning(url, str(exc))
        return None
    except Exception as exc:  # noqa: BLE001
        # SQLAlchemy's NoSuchModuleError + any other engine-construction
        # failure shouldn't take down boot. Tell the user; degrade.
        exc_name = type(exc).__name__
        if exc_name in ("NoSuchModuleError", "ArgumentError", "OperationalError"):
            _print_driver_warning(url, f"{exc_name}: {exc}")
            return None
        raise


def _print_driver_warning(url: str, detail: str) -> None:
    # Shorten the URL so we don't print credentials to logs.
    scheme = url.split("://", 1)[0] if "://" in url else url
    print(
        f"[gravel] Could not open database (scheme={scheme!r}): {detail}. "
        f"Degrading to prompts-only mode. "
        f"For Postgres, install psycopg2-binary: `uv add psycopg2-binary` "
        f"(or `pip install psycopg2-binary`).",
        file=sys.stderr,
    )
