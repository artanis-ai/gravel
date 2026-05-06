"""Mount the dashboard route into the user's app entry. Parity with src/wizard/mount.ts.

v0: AST-aware edits land iteratively. For now, FastAPI gets a generated
gravel_route.py; Django + generic frameworks print copy-paste instructions.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .detect import DetectionResult


MountMode = Literal["created", "updated", "manual-instructions"]


@dataclass
class MountResult:
    path: str
    mode: MountMode


def mount_dashboard_route(detection: DetectionResult, cwd: str | Path, mount_path: str) -> MountResult | None:
    cwd = Path(cwd)
    if detection.framework == "fastapi":
        return _mount_fastapi(cwd, mount_path)
    if detection.framework == "django":
        return _mount_django_instructions(mount_path)
    if detection.framework in ("generic-asgi", "generic-wsgi", "flask"):
        return _mount_generic_instructions(mount_path)
    return None


def _mount_fastapi(cwd: Path, mount_path: str) -> MountResult:
    file = cwd / "gravel_route.py"
    if file.exists():
        bak = file.with_suffix(file.suffix + ".gravel.bak")
        bak.write_text(file.read_text(encoding="utf-8"), encoding="utf-8")
    file.write_text(
        "from artanis_gravel.fastapi import create_gravel_router\n"
        "from gravel_config import config\n\n"
        "router = create_gravel_router(config=config)\n",
        encoding="utf-8",
    )

    # Try to AST-edit a likely FastAPI entry (main.py / app.py) to register
    # the router automatically. If libcst can't make a safe edit, fall back
    # to printing copy-paste instructions.
    edited = _try_libcst_inject_router(cwd, mount_path)
    if not edited:
        print(
            f"\n[gravel] Add to your FastAPI app:\n"
            f"\n    from gravel_route import router\n"
            f"    app.include_router(router, prefix='{mount_path}')\n"
        )
    return MountResult(path=str(file), mode="created")


def _try_libcst_inject_router(cwd: Path, mount_path: str) -> bool:
    """Best-effort libcst edit of a FastAPI entrypoint.

    Returns True if we appended the wiring lines to a likely entry file.
    Conservative: only acts on files whose source already references
    ``FastAPI(`` and only appends at the end (no in-place restructuring).
    """
    candidates = [cwd / name for name in ("main.py", "app.py", "asgi.py")]
    target = next((p for p in candidates if p.exists()), None)
    if target is None:
        return False
    try:
        import libcst as cst  # noqa: F401
    except ImportError:
        # TODO(libcst): graceful degrade if libcst is missing in the host env.
        return False

    src = target.read_text(encoding="utf-8")
    if "FastAPI(" not in src:
        return False
    if "gravel_route" in src:
        return True  # already wired

    addition = (
        "\n# Added by Gravel wizard\n"
        "from gravel_route import router as _gravel_router\n"
        f"app.include_router(_gravel_router, prefix='{mount_path}')\n"
    )
    bak = target.with_suffix(target.suffix + ".gravel.bak")
    bak.write_text(src, encoding="utf-8")
    target.write_text(src.rstrip() + "\n" + addition, encoding="utf-8")
    return True


def _mount_django_instructions(mount_path: str) -> MountResult:
    print(
        f"\n[gravel] Add the following to your root urls.py:\n"
        f"\n    from django.urls import path, include"
        f"\n    from artanis_gravel.django import gravel_urls\n"
        f"\n    urlpatterns = ["
        f"\n        # ... your existing routes ..."
        f"\n        path('{mount_path.lstrip('/')}/', include(gravel_urls)),"
        f"\n    ]\n"
    )
    return MountResult(path="<your urls.py>", mode="manual-instructions")


def _mount_generic_instructions(mount_path: str) -> MountResult:
    print(
        f"\n[gravel] No automatic mounting available for this framework. "
        f"Mount the ASGI handler at {mount_path} using `artanis_gravel.asgi.GravelAsgiApp`. "
        f"See the README at https://github.com/artanis-ai/gravel\n"
    )
    return MountResult(path="<your app entry>", mode="manual-instructions")
