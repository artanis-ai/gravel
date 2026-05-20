"""Regression for the eager-DB-connect-at-import-time bug.

Pre-v0.9.1, `create_gravel_router` called `open_database(url)` directly.
If the driver was missing (e.g. `psycopg2` not installed for a
`postgresql://` URL), the resulting ImportError took down the whole
FastAPI app at import — no logs, just a uvicorn zombie. Claude's
de_platform install (2026-05-20) was the canonical case.

v0.9.1 routes through `try_open_database` which catches the import /
driver errors and degrades to engine=None. The dashboard SPA still
renders; samples routes return empty pages; the user gets an
actionable stderr message instead of a silent crash.
"""
from __future__ import annotations

import builtins

import pytest

from artanis_gravel.db import try_open_database


def test_try_open_returns_engine_on_valid_sqlite(tmp_path):
    """Happy path — valid SQLite URL produces an Engine."""
    url = f"file:{tmp_path / 'test.db'}"
    engine = try_open_database(url)
    assert engine is not None
    # Engine is functional (can issue a no-op).
    with engine.connect() as conn:
        from sqlalchemy import text
        assert conn.execute(text("select 1")).scalar() == 1


def test_try_open_degrades_on_missing_driver(monkeypatch, capsys):
    """Driver missing → returns None + prints actionable stderr."""
    real_import = builtins.__import__

    def deny_psycopg(name, *args, **kwargs):
        # Simulate psycopg2 not installed: every shape of import fails
        # with ModuleNotFoundError, matching what pip-without-the-extra
        # ships.
        if name == "psycopg2" or name.startswith("psycopg2."):
            raise ModuleNotFoundError("No module named 'psycopg2'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", deny_psycopg)

    # A postgresql:// URL triggers SQLAlchemy's psycopg2 driver lookup.
    engine = try_open_database("postgresql://user:pass@localhost/db")
    assert engine is None, "expected None when driver is missing"
    captured = capsys.readouterr()
    # Stderr must mention what to do — pointing at psycopg2-binary.
    assert "psycopg2" in captured.err.lower()
    assert "prompts-only" in captured.err.lower()


def test_try_open_degrades_on_malformed_url(capsys):
    """Garbage URL → None + warning, no crash.

    Wizard-generated URLs always pass `detect_dialect`, but hand-edited
    configs can have typos (`posgresql://`, missing scheme, etc.).
    Boot must survive."""
    engine = try_open_database("this-is-not-a-url")
    assert engine is None
    captured = capsys.readouterr()
    assert "prompts-only" in captured.err.lower()


def test_try_open_does_not_leak_credentials(monkeypatch, capsys):
    """Stderr warning must not echo the full URL (which may contain
    a password). Only the scheme part is shown."""
    real_import = builtins.__import__

    def deny_psycopg(name, *args, **kwargs):
        if name == "psycopg2" or name.startswith("psycopg2."):
            raise ModuleNotFoundError("No module named 'psycopg2'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", deny_psycopg)

    engine = try_open_database(
        "postgresql://user:s3cret-password@host.example.com/dbname"
    )
    assert engine is None
    captured = capsys.readouterr()
    # Credentials must NOT appear in stderr.
    assert "s3cret-password" not in captured.err
    assert "user:s3cret" not in captured.err
    # Scheme must appear (so the user can locate the problem).
    assert "postgresql" in captured.err


def test_create_gravel_router_survives_broken_driver(monkeypatch):
    """Top-level seam: even if the DB driver is missing,
    create_gravel_router must still return a router so the host app
    boots. Olly + Claude's de_platform install was the canonical
    failure: uvicorn --reload didn't pick up the boot crash, the
    last-good build kept serving 200s, and LLM endpoints hung."""
    real_import = builtins.__import__

    def deny_psycopg(name, *args, **kwargs):
        if name == "psycopg2" or name.startswith("psycopg2."):
            raise ModuleNotFoundError("No module named 'psycopg2'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", deny_psycopg)

    pytest.importorskip("fastapi")
    from artanis_gravel.fastapi import create_gravel_router
    from artanis_gravel.types import GravelConfig

    config = GravelConfig(
        database={"url": "postgresql://user:pw@db.example.com/db"},
        auth={"default_password": "test"},
    )
    router = create_gravel_router(config)
    # Router built despite the broken driver — boot survives.
    assert router is not None
