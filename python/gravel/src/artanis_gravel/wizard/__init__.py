"""Wizard. Parity with packages/sdk-ts/src/wizard/.

v0 implementation status mirrors the TS side; see
packages/sdk-ts/src/wizard/index.ts for the per-step status. ``init`` is
always local: the CLI never phones home. Sign-in for cloud features lives
in the dashboard.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from .config_file import generate_config_file
from .detect import DetectionResult, detect
from .env import generate_password, write_env_additions
from .migrate import run_bootstrap
from .mount import mount_dashboard_route
from .oauth import resolve_control_plane_url

AuthMode = Literal["local", "flags"]


def run_wizard(
    *,
    api_key: str | None = None,
    project: str | None = None,
    project_id: str | None = None,
    mount_path: str = "/admin/ai",
    no_migrate: bool = False,
    no_hook: bool = False,
    no_deep_scan: bool = False,
    no_test_trace: bool = False,
    cwd: str | Path | None = None,
) -> dict[str, Any]:
    """Synchronous wizard entry point.

    The CLI is always local. Pass ``api_key`` + ``project`` (or set
    ``GRAVEL_API_KEY`` + ``GRAVEL_PROJECT_ID`` in the environment) for CI /
    scripted installs that want creds pre-baked into ``.env``. Otherwise
    cloud features are enabled later from the dashboard's sign-in flow.

    ``project_id`` is accepted as an alias for ``project`` so test callsites
    that mirror the TS option naming work without wrapping.
    """
    cwd = Path(cwd) if cwd else Path.cwd()
    blockers: list[str] = []
    project = project or project_id

    detection = detect(cwd)
    print(
        f"Detected {detection.language}, {detection.framework}, "
        f"pkg={detection.package_manager}, db={detection.database['driver']}, "
        f"auth={detection.auth}"
    )

    # Step 2 — auth resolution. Always local unless explicit flags / env
    # supply both api_key and project.
    api_key_resolved, project_resolved, auth_mode = _resolve_credentials(
        api_key=api_key,
        project=project,
    )

    # Step 4 — write .env additions (random admin password per D-Q70).
    # In local mode we omit the cloud creds entirely; the dashboard's sign-in
    # flow plugs them in lazily when the user clicks a cloud feature.
    password = generate_password()
    env_vars: dict[str, str] = {"GRAVEL_ADMIN_PASSWORD": password}
    if project_resolved is not None:
        env_vars["GRAVEL_PROJECT_ID"] = project_resolved
    if api_key_resolved is not None:
        env_vars["GRAVEL_API_KEY"] = api_key_resolved
    write_env_additions(cwd, env_vars)

    # Step 5 — generate gravel_config.py + mount dashboard route.
    mounted = mount_dashboard_route(detection, cwd, mount_path)
    generate_config_file(detection, cwd, mount_path=mount_path)

    # Step 6 — run schema bootstrap (idempotent).
    ran_bootstrap = False
    if not no_migrate:
        try:
            run_bootstrap(cwd)
            ran_bootstrap = True
        except Exception as e:  # noqa: BLE001 — surfacing as a blocker.
            blockers.append(f"Schema bootstrap failed: {e}")

    # Step 7 — pre-commit hook for the manifest.
    installed_hook: dict[str, Any] | None = None
    if not no_hook and detection.has_git:
        from ..manifest import install_hook

        result = install_hook(cwd)
        installed_hook = {"mode": result.mode, "path": result.path}

    # Step 8 — BLOCKER (deep scan).
    if not no_deep_scan:
        blockers.append("Deep prompt scan not implemented yet.")

    # Step 9 — BLOCKER (test trace).
    if not no_test_trace:
        blockers.append("Test trace not implemented yet.")

    # Step 10 — friendly success print.
    print("")
    print("Gravel skeleton installed. Next:")
    print(f"  1. Visit {mount_path} in your app and log in.")
    print("  2. Edit your get_user callback in gravel_config.py to match your auth.")

    return {
        "detection": detection,
        "mounted": mounted,
        "ran_bootstrap": ran_bootstrap,
        "installed_hook": installed_hook,
        "password_generated": password,
        "api_key": api_key_resolved,
        "project_id": project_resolved,
        "auth_mode": auth_mode,
        "control_plane": resolve_control_plane_url(),
        "blockers": blockers,
    }


def _resolve_credentials(
    *,
    api_key: str | None,
    project: str | None,
) -> tuple[str | None, str | None, AuthMode]:
    """Return ``(api_key, project_id, auth_mode)``.

    ``flags`` mode requires both api_key and project to be set (via flag or
    env). Anything else lands in ``local`` mode with both creds as ``None``.
    """
    env_api_key = os.environ.get("GRAVEL_API_KEY")
    env_project = os.environ.get("GRAVEL_PROJECT_ID")

    resolved_api = api_key or env_api_key
    resolved_project = project or env_project

    if resolved_api and resolved_project:
        return resolved_api, resolved_project, "flags"

    return None, None, "local"


# Backwards-compatible alias matching the task description (`init(...)`).
def init(**kwargs: Any) -> dict[str, Any]:
    """Alias for :func:`run_wizard` — matches the public name in the spec."""
    return run_wizard(**kwargs)


__all__ = [
    "DetectionResult",
    "detect",
    "init",
    "run_bootstrap",
    "run_wizard",
]
