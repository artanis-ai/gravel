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
      1. `GRAVEL_DASHBOARD_DIST` env var override (set by hand or by
         the wizard when it knows where a built dist lives).
      2. Bundled in the wheel at `artanis_gravel/_dashboard_dist/`.
         This is what pip/uv-installed customers hit; the build hook
         in pyproject.toml copies `packages/dashboard/dist/` into the
         wheel at this location.
      3. Sibling repo layout — `gravel/packages/dashboard/dist/`
         reached by walking up from this file's location. This is the
         dev-time fallback for `uv pip install -e ./python/gravel`.
    """
    override = os.environ.get(_ENV)
    if override:
        p = Path(override)
        return p if (p / "index.html").exists() else None

    # Bundled location (inside the installed package).
    here = Path(__file__).resolve()
    bundled = here.parent / "_dashboard_dist"
    if (bundled / "index.html").exists():
        return bundled

    # Editable-install fallback: walk up looking for sibling
    # packages/dashboard/dist.
    for parent in here.parents:
        candidate = parent / "packages" / "dashboard" / "dist"
        if (candidate / "index.html").exists():
            return candidate
    return None
