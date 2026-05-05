"""Wraps schema migration. Parity with src/wizard/migrate.ts.

Tries Alembic first (if revisions exist); falls back to bootstrap if not.
"""
from __future__ import annotations

import os
from pathlib import Path

from ..db import open_database
from ..db.bootstrap import bootstrap


def run_bootstrap(cwd: str | Path) -> None:
    """Public entry — used by the wizard and the `gravel migrate` CLI command.

    Despite the legacy name, this now applies Alembic migrations when they
    exist, falling back to the idempotent bootstrap if no revisions are
    present.
    """
    cwd = Path(cwd)
    env = _read_env(cwd)
    url = env.get("DATABASE_URL") or env.get("POSTGRES_URL") or env.get("NEON_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "[gravel] No DATABASE_URL detected. Set it in .env and re-run "
            "`python -m artanis_gravel migrate`."
        )

    if _has_alembic_revisions():
        _alembic_upgrade(url)
        return

    engine = open_database(url)
    try:
        bootstrap(engine)
    finally:
        engine.dispose()


def _has_alembic_revisions() -> bool:
    """Detect whether the lib's bundled alembic dir has any migration files."""
    pkg_dir = Path(__file__).resolve().parent.parent  # artanis_gravel/
    alembic_versions = pkg_dir.parent.parent / "alembic" / "versions"
    if not alembic_versions.exists():
        return False
    return any(p.suffix == ".py" and p.name != "__init__.py" for p in alembic_versions.iterdir())


def _alembic_upgrade(url: str) -> None:
    """Run `alembic upgrade head` programmatically."""
    try:
        from alembic import command
        from alembic.config import Config
    except ImportError:
        raise RuntimeError(
            "[gravel] Alembic not installed. Run `pip install alembic` (or use the bootstrap fallback by clearing alembic/versions/)."
        )

    pkg_dir = Path(__file__).resolve().parent.parent  # artanis_gravel/
    ini_path = pkg_dir.parent.parent / "alembic.ini"
    cfg = Config(str(ini_path))
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    cfg.set_main_option("sqlalchemy.url", url)
    # Make the script_location absolute so alembic finds the env.py reliably.
    cfg.set_main_option("script_location", str(pkg_dir.parent.parent / "alembic"))
    command.upgrade(cfg, "head")


def _read_env(cwd: Path) -> dict[str, str]:
    out = dict(os.environ)
    for f in (".env", ".env.local"):
        p = cwd / f
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" not in line or line.startswith("#"):
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip("'\"")
            if k and k not in out:
                out[k] = v
    return out
