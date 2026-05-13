"""Version-check helper for the dashboard's "update available" banner.

Port of packages/sdk-ts/src/handler/version.ts to Python. The TS SDK
queries the npm registry; this module queries PyPI. Both expose the
same shape to the dashboard so UpdateBanner.tsx doesn't have to know
which language is running.

Strategy:
  - `current` is the running SDK's installed version, read via
    `importlib.metadata` (works for both editable and wheel installs).
    No hard-coded fallback in the source — that's how the previous
    `CURRENT_VERSION = "0.1.0"` stayed wrong across five releases.
  - `latest` is fetched once per process and cached for one hour
    (`CHECK_INTERVAL_MS`), matching the TS side. PyPI's JSON endpoint
    is rate-friendly but we still throttle.
  - Network failures swallow to None; the banner just doesn't appear.
  - `GRAVEL_VERSION_CHECK_DISABLED=1` opts out entirely, same env var
    name as the TS side.
  - `packageManager` is detected from the cwd's lockfiles (uv.lock /
    poetry.lock / Pipfile.lock / fallback pip). `language` is always
    'python' from here.
"""
from __future__ import annotations

import os
import threading
import time
from importlib import metadata
from pathlib import Path
from typing import Literal

CHECK_INTERVAL_S = 60 * 60  # 1h, same as TS

_PYPI_URL = "https://pypi.org/pypi/artanis-gravel/json"

PackageManager = Literal["uv", "pip", "poetry", "pipenv"]
Language = Literal["python"]


# Module-level cache. Guarded by a lock so a thundering herd of dashboard
# tabs doesn't fan out to PyPI on cold start.
_lock = threading.Lock()
_cached_latest: tuple[float, str | None] | None = None  # (fetched_at, latest)
_cached_current: str | None = None


def _read_current_version() -> str:
    """Returns the installed package version. Cached on first call.

    importlib.metadata works for both wheels and editable installs
    (`uv pip install -e .` or `pip install -e .`). Returns
    "0.0.0-unknown" if the package isn't registered, which only
    happens in weird test setups."""
    global _cached_current
    if _cached_current is not None:
        return _cached_current
    try:
        _cached_current = metadata.version("artanis-gravel")
    except metadata.PackageNotFoundError:
        _cached_current = "0.0.0-unknown"
    return _cached_current


def _fetch_latest_from_pypi() -> str | None:
    """Pull the latest version off PyPI. Returns None on any failure
    (network blocked, non-200, parse error, etc.) so the caller can
    decide to fall back."""
    if os.environ.get("GRAVEL_VERSION_CHECK_DISABLED") == "1":
        return None
    try:
        import urllib.request

        req = urllib.request.Request(_PYPI_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                return None
            import json as _json

            body = _json.loads(resp.read().decode("utf-8"))
        info = body.get("info") or {}
        v = info.get("version")
        return v if isinstance(v, str) else None
    except Exception:
        return None


def _get_latest() -> str | None:
    """Returns the cached latest-version string, refreshing if stale.
    Thread-safe — the inflight check serialises concurrent callers."""
    global _cached_latest
    now = time.monotonic()
    with _lock:
        if _cached_latest and (now - _cached_latest[0]) < CHECK_INTERVAL_S:
            return _cached_latest[1]
    # Outside the lock: do the network call, then update cache atomically.
    latest = _fetch_latest_from_pypi()
    with _lock:
        _cached_latest = (now, latest)
    return latest


def _parse_semver(v: str) -> list[int]:
    """Best-effort semver parse. Strips leading 'v', drops pre-release
    suffixes, returns int components. Non-numeric pieces become 0 so
    the comparator doesn't need to special-case 'rc1' etc."""
    core = v.lstrip("v").split("-", 1)[0].split("+", 1)[0]
    out: list[int] = []
    for part in core.split("."):
        try:
            out.append(int(part))
        except ValueError:
            out.append(0)
    return out


def _is_newer(current: str, latest: str) -> bool:
    """True if `latest` is strictly newer than `current` by semver."""
    a, b = _parse_semver(current), _parse_semver(latest)
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else 0
        y = b[i] if i < len(b) else 0
        if y > x:
            return True
        if y < x:
            return False
    return False


def _detect_package_manager(cwd: Path | None = None) -> PackageManager:
    """Detect the host's Python package manager from lockfiles. Matches
    the precedence the TS SDK uses for host-stack detection so the
    dashboard renders the same install commands regardless of which
    SDK is serving."""
    root = cwd or Path.cwd()
    if (root / "uv.lock").exists():
        return "uv"
    if (root / "poetry.lock").exists():
        return "poetry"
    if (root / "Pipfile.lock").exists():
        return "pipenv"
    return "pip"


def get_version_info() -> dict:
    """Build the response payload for GET /api/version.

    Shape matches packages/dashboard/src/components/UpdateBanner.tsx
    `VersionInfo`. `language` is fixed to "python" because this module
    only runs inside the Python SDK; the TS SDK has its own helper."""
    current = _read_current_version()
    latest = _get_latest()
    return {
        "current": current,
        "latest": latest,
        "hasUpdate": latest is not None and _is_newer(current, latest),
        "packageManager": _detect_package_manager(),
        "language": "python",
    }


def _reset_cache_for_tests() -> None:
    """Test seam: clears the module-level caches so a test can replay
    the cold-start path without restarting the interpreter."""
    global _cached_current, _cached_latest
    _cached_current = None
    _cached_latest = None
