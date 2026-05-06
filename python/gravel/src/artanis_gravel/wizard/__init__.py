"""Wizard. Parity with packages/sdk-ts/src/wizard/.

v0 implementation status mirrors the TS side; see
packages/sdk-ts/src/wizard/index.ts for the per-step status. The OAuth step
is opt-in (interactive default = local-only); ``run_login`` provides the lazy
counterpart that adds cloud creds after the fact.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Literal

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

AuthMode = Literal["oauth", "local", "ci", "flags"]


def run_wizard(
    *,
    ci: bool = False,
    local: bool = False,
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
    prompt_input: Any = None,
    prompt_is_tty: bool | None = None,
) -> dict[str, Any]:
    """Synchronous wizard entry point.

    The OAuth step is async under the hood; this wrapper runs it on a new
    event loop. Pass ``cwd`` for testing or to install Gravel into a project
    other than the current working directory.

    ``project_id`` is accepted as an alias for ``project`` so test callsites
    that mirror the TS option naming work without wrapping.

    By default an interactive (TTY) ``init`` prompts the user to choose
    between local-only mode (default) and signing in. Pass ``local=True``
    to skip the prompt entirely; ``ci=True`` keeps the previous CI behavior
    (dev placeholder creds + a blocker).
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

    # Step 2 — auth resolution.
    api_key_resolved, project_resolved, auth_mode, oauth_blocker = _resolve_credentials(
        api_key=api_key,
        project=project,
        ci=ci,
        local=local,
        open_browser=open_browser,
        prompt_input=prompt_input,
        prompt_is_tty=prompt_is_tty,
    )
    if oauth_blocker:
        blockers.append(oauth_blocker)

    # Step 4 — write .env additions (random admin password per D-Q70).
    # In local mode we omit the cloud creds entirely; the user runs `gravel
    # login` later when they want them.
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
    if auth_mode == "local":
        print("  3. When you're ready for cloud features (judge, analyze, evals), run:")
        print("       python -m artanis_gravel login")
    else:
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
        "auth_mode": auth_mode,
        "control_plane": resolve_control_plane_url(),
        "blockers": blockers,
    }


def _resolve_credentials(
    *,
    api_key: str | None,
    project: str | None,
    ci: bool,
    local: bool,
    open_browser: bool,
    prompt_input: Any = None,
    prompt_is_tty: bool | None = None,
) -> tuple[str | None, str | None, AuthMode, str | None]:
    """Resolve credentials in priority order.

    Order:
      1. Explicit flags / env → ``flags`` mode (no OAuth).
      2. ``local=True``       → ``local`` mode (no OAuth, no creds in .env).
      3. ``ci=True``          → ``ci`` mode (dev placeholders + blocker).
      4. Interactive TTY      → prompt; default = local.
      5. Non-TTY fallback     → ``local`` mode (safer than silent OAuth).

    Returns ``(api_key, project_id, auth_mode, blocker_message)``. ``api_key``
    and ``project_id`` are ``None`` only when ``auth_mode == "local"``.
    """
    env_api_key = os.environ.get("GRAVEL_API_KEY")
    env_project = os.environ.get("GRAVEL_PROJECT_ID")

    resolved_api = api_key or env_api_key
    resolved_project = project or env_project

    if resolved_api and resolved_project:
        return resolved_api, resolved_project, "flags", None

    if local:
        print(
            "Local-only install: skipping cloud sign-in. "
            "Run `python -m artanis_gravel login` later to enable cloud features."
        )
        return None, None, "local", None

    if ci:
        # Non-interactive mode can't open a browser; emit a mock pair so the
        # rest of the wizard is still useful for inspection.
        mock_api = resolved_api or f"grk_dev_{_random(20)}"
        mock_project = resolved_project or f"proj_dev_{_random(12)}"
        return (
            mock_api,
            mock_project,
            "ci",
            "OAuth skipped in --ci mode without --api-key/--project. "
            "Wrote dev-mode placeholder credentials to .env.",
        )

    # Interactive prompt — default to local.
    is_tty = prompt_is_tty if prompt_is_tty is not None else sys.stdin.isatty()
    if not is_tty:
        # No TTY: don't silently phone home. Equivalent to local mode.
        print(
            "Local-only install (no TTY for prompt): skipping cloud sign-in. "
            "Run `python -m artanis_gravel login` later to enable cloud features."
        )
        return None, None, "local", None

    answer = _ask_choice(
        (
            "\nGravel can run in two modes:\n"
            "  [L] Local-only — install everything without contacting Artanis cloud (default).\n"
            "  [s] Sign in    — open your browser to mint a project ID + API key\n"
            "                   (enables judge, analyze, evals, and managed dashboards).\n"
            "\n"
            "Choice [L/s]: "
        ),
        choices=("l", "s"),
        default="l",
        stdin=prompt_input,
    )

    if answer == "l":
        print(
            "Local-only install. Run `python -m artanis_gravel login` later to enable cloud features."
        )
        return None, None, "local", None

    # answer == "s" — run OAuth.
    try:
        creds: WizardCredentials = asyncio.run(
            browser_oauth_handshake(open_browser=open_browser)
        )
    except OAuthError as exc:
        # Surface as a blocker but don't crash — fall back to local.
        return (
            None,
            None,
            "local",
            f"OAuth handshake failed: {exc}. Falling back to local-only mode.",
        )

    return creds.api_key, creds.project_id, "oauth", None


def _ask_choice(prompt: str, *, choices: tuple[str, ...], default: str, stdin: Any = None) -> str:
    """Prompt the user for a single-letter choice. Returns lowercased letter
    or the default on empty / unrecognised input."""
    if stdin is None:
        try:
            answer = input(prompt).strip().lower()
        except EOFError:
            return default
    else:
        # Test injection: read first line of the provided stdin-like.
        sys.stdout.write(prompt)
        sys.stdout.flush()
        line = stdin.readline()
        answer = (line or "").strip().lower()
    if not answer:
        return default
    letter = answer[0]
    return letter if letter in choices else default


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
