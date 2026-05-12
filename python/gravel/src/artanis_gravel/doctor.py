"""``artanis-gravel doctor`` — Python parity with the TS CLI's ``gravel doctor``.

Prints the installed SDK version, what PyPI has at the latest tag, the
detected host stack, and the exact upgrade command for that stack.
Exit code is non-zero when an update is available, so CI can gate on
``artanis-gravel doctor`` without parsing output.

Mirrors packages/sdk-ts/src/cli/doctor.ts. Same opt-out
(``GRAVEL_VERSION_CHECK_DISABLED=1``).
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass
from importlib import metadata
from pathlib import Path
from typing import Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

PYPI_URL = "https://pypi.org/pypi/artanis-gravel/json"
TIMEOUT_S = 5
PACKAGE_NAME = "artanis-gravel"


@dataclass
class VersionInfo:
    current: str
    latest: Optional[str]
    has_update: bool
    package_manager: str
    language: str = "python"


def _read_installed_version() -> str:
    """Read this package's version from the installed metadata.

    Falls back to ``0.0.0-unknown`` when the package isn't installed
    (running from source without an ``editable`` install would do that).
    """
    try:
        return metadata.version(PACKAGE_NAME)
    except metadata.PackageNotFoundError:
        return "0.0.0-unknown"


def _fetch_latest_from_pypi() -> Optional[str]:
    """Fetch the latest version from PyPI.

    Honours ``GRAVEL_VERSION_CHECK_DISABLED=1``. Returns ``None`` on any
    network or parse failure — the wrapper degrades to "unknown".
    """
    if os.environ.get("GRAVEL_VERSION_CHECK_DISABLED") == "1":
        return None
    try:
        req = Request(PYPI_URL, headers={"Accept": "application/json"})
        with urlopen(req, timeout=TIMEOUT_S) as resp:  # noqa: S310 (URL hardcoded above)
            if resp.status != 200:
                return None
            data = json.loads(resp.read().decode("utf-8"))
        latest = data.get("info", {}).get("version")
        return latest if isinstance(latest, str) else None
    except (URLError, TimeoutError, ValueError):
        return None


def _detect_package_manager(cwd: Path) -> str:
    """Mirror handler/host-stack.ts' Python branch.

    Lockfile precedence: uv → poetry → pipenv → pip. We never return
    a JS manager from the Python doctor — the package name itself
    (``artanis-gravel`` not ``@artanis-ai/gravel``) signals to the
    caller that they're in a Python project.
    """
    if (cwd / "uv.lock").exists():
        return "uv"
    if (cwd / "poetry.lock").exists():
        return "poetry"
    if (cwd / "Pipfile.lock").exists():
        return "pipenv"
    return "pip"


def _parse_semver(v: str) -> list[int]:
    """Parse a semver string into numeric parts, dropping pre-release tags."""
    v = v.lstrip("v").split("-", 1)[0].split("+", 1)[0]
    out: list[int] = []
    for p in v.split("."):
        try:
            out.append(int(p))
        except ValueError:
            return []
    return out


def is_newer(a: str, b: str) -> bool:
    """Return True if ``b`` is strictly newer than ``a``."""
    aa = _parse_semver(a)
    bb = _parse_semver(b)
    if not aa or not bb:
        return b > a
    for x, y in zip(aa + [0] * len(bb), bb + [0] * len(aa)):
        if y > x:
            return True
        if y < x:
            return False
    return False


def update_command(manager: str, target: str, pkg: str = PACKAGE_NAME) -> str:
    """The exact upgrade command for the detected host stack."""
    if manager == "uv":
        return f"uv pip install --upgrade {pkg}=={target}"
    if manager == "poetry":
        return f"poetry add {pkg}@{target}"
    if manager == "pipenv":
        # pipenv has no per-version-target syntax.
        return f"pipenv update {pkg}"
    return f"pip install --upgrade {pkg}=={target}"


def get_version_info(cwd: Optional[Path] = None) -> VersionInfo:
    cwd = cwd or Path.cwd()
    current = _read_installed_version()
    latest = _fetch_latest_from_pypi()
    return VersionInfo(
        current=current,
        latest=latest,
        has_update=bool(latest) and is_newer(current, latest or ""),
        package_manager=_detect_package_manager(cwd),
    )


def render_doctor(info: VersionInfo) -> str:
    lines: list[str] = []
    lines.append(f"{PACKAGE_NAME} {info.current}")
    lines.append(f"  stack: {info.language} ({info.package_manager})")
    if info.latest is None:
        lines.append(
            "  latest: (unknown — PyPI unreachable or version check disabled)",
        )
    elif info.has_update:
        lines.append(f"  latest: {info.latest}")
        lines.append("")
        lines.append("  Update available. Run:")
        lines.append(f"    {update_command(info.package_manager, info.latest)}")
    else:
        lines.append(f"  latest: {info.latest} (up to date)")
    return "\n".join(lines)


def run_doctor(as_json: bool = False) -> int:
    """Entrypoint: print info, return the desired process exit code."""
    info = get_version_info()
    if as_json:
        # asdict serialises the dataclass; rename to match the TS shape
        # so consumers can parse the same JSON regardless of language.
        out = asdict(info)
        out["hasUpdate"] = out.pop("has_update")
        out["packageManager"] = out.pop("package_manager")
        sys.stdout.write(json.dumps(out, indent=2) + "\n")
    else:
        sys.stdout.write(render_doctor(info) + "\n")
    return 1 if info.has_update else 0
