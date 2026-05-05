"""Wizard. Parity with packages/sdk-ts/src/wizard/.

v0 implementation status mirrors the TS side; see
packages/sdk-ts/src/wizard/index.ts for the per-step status.
"""
from __future__ import annotations

from pathlib import Path

from .detect import detect, DetectionResult
from .env import generate_password, write_env_additions
from .config_file import generate_config_file
from .mount import mount_dashboard_route
from .migrate import run_bootstrap


def run_wizard(
    *,
    ci: bool = False,
    api_key: str | None = None,
    project: str | None = None,
    mount_path: str = "/admin/ai",
    no_migrate: bool = False,
    no_hook: bool = False,
    no_deep_scan: bool = False,
    no_test_trace: bool = False,
) -> dict:
    cwd = Path.cwd()
    blockers: list[str] = []

    detection = detect(cwd)
    print(
        f"Detected {detection.language}, {detection.framework}, "
        f"pkg={detection.package_manager}, db={detection.database['driver']}, auth={detection.auth}"
    )

    # Step 2 (OAuth) — STUBBED
    import os
    api_key_resolved = api_key or os.environ.get("GRAVEL_API_KEY") or f"grk_dev_{_random(20)}"
    project_resolved = project or os.environ.get("GRAVEL_PROJECT_ID") or f"proj_dev_{_random(12)}"
    if not api_key and not os.environ.get("GRAVEL_API_KEY"):
        blockers.append(
            "Wizard OAuth not available: control plane not provisioned. "
            "Using a dev-mode mock API key."
        )

    # Step 4
    password = generate_password()
    write_env_additions(cwd, {
        "GRAVEL_PROJECT_ID": project_resolved,
        "GRAVEL_API_KEY": api_key_resolved,
        "GRAVEL_ADMIN_PASSWORD": password,
    })

    # Step 5
    mounted = mount_dashboard_route(detection, cwd, mount_path)
    generate_config_file(detection, cwd, mount_path=mount_path)

    # Step 6
    ran_bootstrap = False
    if not no_migrate:
        try:
            run_bootstrap(cwd)
            ran_bootstrap = True
        except Exception as e:
            blockers.append(f"Schema bootstrap failed: {e}")

    # Step 7
    installed_hook = None
    if not no_hook and detection.has_git:
        from ..manifest import install_hook
        result = install_hook(cwd)
        installed_hook = {"mode": result.mode, "path": result.path}

    # Step 8 — BLOCKER
    if not no_deep_scan:
        blockers.append("Deep prompt scan not implemented yet.")

    # Step 9 — BLOCKER
    if not no_test_trace:
        blockers.append("Test trace not implemented yet.")

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
        "blockers": blockers,
    }


def _random(length: int) -> str:
    import secrets
    import string
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


__all__ = ["run_wizard", "run_bootstrap", "DetectionResult", "detect"]
