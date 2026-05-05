"""Wizard. Parity with packages/sdk-ts/src/wizard/.

v0 implementation status mirrors the TS side; see
packages/sdk-ts/src/wizard/index.ts for the per-step status. The OAuth step
on the Python side is now live (see ``oauth.py``); the TS equivalent remains
stubbed until the TS CLI is wired up.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from .config_file import generate_config_file
from .detect import DetectionResult, detect
from .env import generate_password, write_env_additions
from .migrate import run_bootstrap
from .mount import mount_dashboard_route
from .oauth import (
    OAuthError,
    WizardCredentials,
    browser_oauth_handshake,
    resolve_control_plane_url,
)


def run_wizard(
    *,
    ci: bool = False,
    api_key: str | None = None,
    project: str | None = None,
    project_id: str | None = None,
    mount_path: str = "/admin/ai",
    no_migrate: bool = False,
    no_hook: bool = False,
    no_deep_scan: bool = False,
    no_test_trace: bool = False,
    cwd: str | Path | None = None,
    open_browser: bool = True,
) -> dict[str, Any]:
    """Synchronous wizard entry point.

    The OAuth step is async under the hood; this wrapper runs it on a new
    event loop. Pass ``cwd`` for testing or to install Gravel into a project
    other than the current working directory.

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

    # Step 2 (OAuth) — live against gravel.artanis.ai
    api_key_resolved, project_resolved, oauth_blocker = _resolve_credentials(
        api_key=api_key,
        project=project,
        ci=ci,
        open_browser=open_browser,
    )
    if oauth_blocker:
        blockers.append(oauth_blocker)

    # Step 4 — write .env additions (random admin password per D-Q70).
    password = generate_password()
    write_env_additions(
        cwd,
        {
            "GRAVEL_PROJECT_ID": project_resolved,
            "GRAVEL_API_KEY": api_key_resolved,
            "GRAVEL_ADMIN_PASSWORD": password,
        },
    )

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
    print("  3. Connect GitHub from Settings (when available).")
    print("  4. Read https://gravel.artanis.ai/docs")

    return {
        "detection": detection,
        "mounted": mounted,
        "ran_bootstrap": ran_bootstrap,
        "installed_hook": installed_hook,
        "password_generated": password,
        "api_key": api_key_resolved,
        "project_id": project_resolved,
        "control_plane": resolve_control_plane_url(),
        "blockers": blockers,
    }


def _resolve_credentials(
    *,
    api_key: str | None,
    project: str | None,
    ci: bool,
    open_browser: bool,
) -> tuple[str, str, str | None]:
    """Resolve credentials in priority order: explicit flags → env → OAuth.

    Returns ``(api_key, project_id, blocker_message)``. A blocker message is
    only returned when we had to fall back to a dev-mode mock (which only
    happens in ``--ci`` mode without flags or env, since that path can't
    open a browser).
    """
    env_api_key = os.environ.get("GRAVEL_API_KEY")
    env_project = os.environ.get("GRAVEL_PROJECT_ID")

    resolved_api = api_key or env_api_key
    resolved_project = project or env_project

    if resolved_api and resolved_project:
        return resolved_api, resolved_project, None

    if ci:
        # Non-interactive mode can't open a browser; emit a mock pair so the
        # rest of the wizard is still useful for inspection.
        mock_api = resolved_api or f"grk_dev_{_random(20)}"
        mock_project = resolved_project or f"proj_dev_{_random(12)}"
        return (
            mock_api,
            mock_project,
            "OAuth skipped in --ci mode without --api-key/--project. "
            "Wrote dev-mode placeholder credentials to .env.",
        )

    try:
        creds: WizardCredentials = asyncio.run(
            browser_oauth_handshake(open_browser=open_browser)
        )
    except OAuthError as exc:
        # Surface as a blocker but don't crash — write mock creds so the
        # user can re-run with `--api-key`.
        mock_api = resolved_api or f"grk_dev_{_random(20)}"
        mock_project = resolved_project or f"proj_dev_{_random(12)}"
        return mock_api, mock_project, f"OAuth handshake failed: {exc}"

    return creds.api_key, creds.project_id, None


def _random(length: int) -> str:
    import secrets
    import string

    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


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
