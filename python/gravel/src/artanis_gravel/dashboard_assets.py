"""Locate the bundled dashboard SPA at runtime.

The dashboard is built from `gravel/packages/dashboard/` (Vite + React)
into `dist/`. We don't currently embed the bytes in the wheel; we resolve
the path against the sibling JS SDK's source tree on disk. Good enough for
local dogfooding; the proper fix is to copy the dist into the wheel at
build time (see TODO below).
"""
from __future__ import annotations

import os
from pathlib import Path

_ENV = "GRAVEL_DASHBOARD_DIST"


def find_dashboard_dist() -> Path | None:
    """Return the path to the built dashboard `dist/` dir, or None.

    Resolution order:
      1. `GRAVEL_DASHBOARD_DIST` env var.
      2. Sibling repo layout — `gravel/packages/dashboard/dist/` reached
         from this file's location: walk up past `python/gravel/src/...`
         until we find a `packages/dashboard/dist/` directory.
    """
    override = os.environ.get(_ENV)
    if override:
        p = Path(override)
        return p if (p / "index.html").exists() else None

    # walk up from this file looking for sibling packages/dashboard/dist
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "packages" / "dashboard" / "dist"
        if (candidate / "index.html").exists():
            return candidate
    return None
