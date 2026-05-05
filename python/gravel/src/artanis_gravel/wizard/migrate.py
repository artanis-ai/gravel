"""Wraps the schema bootstrap. Parity with src/wizard/migrate.ts."""
from __future__ import annotations

import os
from pathlib import Path

from ..db import open_database
from ..db.bootstrap import bootstrap


def run_bootstrap(cwd: str | Path) -> None:
    cwd = Path(cwd)
    env = _read_env(cwd)
    url = env.get("DATABASE_URL") or env.get("POSTGRES_URL") or env.get("NEON_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "[gravel] No DATABASE_URL detected. Set it in .env and re-run "
            "`python -m artanis_gravel migrate`."
        )
    engine = open_database(url)
    bootstrap(engine)


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
