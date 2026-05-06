"""``gravel login`` — lazy-auth counterpart to ``init --local``.

Runs the OAuth handshake against ``gravel.artanis.ai`` and appends the
resulting ``GRAVEL_PROJECT_ID`` and ``GRAVEL_API_KEY`` to ``.env.local``
(or ``.env`` if ``.env.local`` is absent). Mirrors
packages/sdk-ts/src/cli/login.ts.
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any

from .wizard.env import write_env_additions
from .wizard.oauth import (
    OAuthError,
    WizardCredentials,
    browser_oauth_handshake,
    resolve_control_plane_url,
)


def run_login(
    *,
    cwd: str | Path | None = None,
    open_browser: bool = True,
) -> dict[str, Any]:
    """Run OAuth and write GRAVEL_PROJECT_ID + GRAVEL_API_KEY to .env.

    Short-circuits with ``already_configured=True`` if both keys are already
    present in the env file (prevents accidental overwrites; switching
    projects requires a manual edit).
    """
    cwd = Path(cwd) if cwd else Path.cwd()
    control_plane = resolve_control_plane_url()

    env_file, has_project, has_api = _detect_env(cwd)
    if has_project and has_api:
        print(
            f"GRAVEL_PROJECT_ID and GRAVEL_API_KEY are already set in {env_file}."
        )
        print(
            "To switch projects, remove those two lines manually and re-run "
            "`python -m artanis_gravel login`."
        )
        return {
            "already_configured": True,
            "env_file": env_file,
            "project_id": "",
            "api_key": "",
        }

    print(f"Opening {control_plane}/cli/auth in your browser to sign in…")
    try:
        creds: WizardCredentials = asyncio.run(
            browser_oauth_handshake(open_browser=open_browser)
        )
    except OAuthError as exc:
        raise RuntimeError(f"OAuth handshake failed: {exc}") from exc

    write_env_additions(
        cwd,
        {
            "GRAVEL_PROJECT_ID": creds.project_id,
            "GRAVEL_API_KEY": creds.api_key,
        },
    )

    print(
        f"Authorized {creds.project_name or creds.project_id}"
        + (f" ({creds.organization_name})" if creds.organization_name else "")
    )
    print(f"Wrote GRAVEL_PROJECT_ID + GRAVEL_API_KEY to {env_file}.")
    print("Restart your app to pick up the new env vars.")

    return {
        "already_configured": False,
        "env_file": env_file,
        "project_id": creds.project_id,
        "api_key": creds.api_key,
        "project_name": creds.project_name,
        "organization_name": creds.organization_name,
    }


def _detect_env(cwd: Path) -> tuple[str, bool, bool]:
    """Return ``(filename, has_project_id, has_api_key)``. Defaults to
    ``.env.local`` if neither file exists."""
    project_re = re.compile(r"^GRAVEL_PROJECT_ID=", re.MULTILINE)
    api_re = re.compile(r"^GRAVEL_API_KEY=", re.MULTILINE)
    for candidate in (".env.local", ".env"):
        path = cwd / candidate
        if path.exists():
            text = path.read_text(encoding="utf-8")
            return candidate, bool(project_re.search(text)), bool(api_re.search(text))
    return ".env.local", False, False
