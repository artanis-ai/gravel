"""GitHub install state — read straight from process env.

Port of `packages/sdk-ts/src/github/project-state.ts`. Same env vars,
same CP endpoint, same dev-stub semantics. Both SDKs ride the same
install/token surface so a host that switches between them keeps the
GH App connection.

The install flow (anonymous, no Gravel cloud account required) writes
four env vars to `.env.local` after the App is installed:

    GRAVEL_GH_INSTALL_ID        numeric installation_id GitHub minted
    GRAVEL_GH_INSTALL_SECRET    HMAC-derived bearer for token mints
    GRAVEL_GH_REPO_OWNER        repo the install is scoped to
    GRAVEL_GH_REPO_NAME         repo name

Token minting goes through the CP via `mint_installation_token_via_cp`:
the CP HMAC-verifies the install_secret server-side and forwards a
1-hour repo-scoped GitHub installation token back.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass
class GhInstallState:
    installation_id: int
    repo_owner: str
    repo_name: str
    install_secret: str  # treat as a password


def read_gh_install_state_from_env() -> GhInstallState | None:
    """Pull state from the current process env. Returns None when any
    required var is missing or invalid.

    Dev stub: `GRAVEL_GH_DEV_STUB=1` bypasses GitHub + CP entirely (used
    by the fixture suite and UI iteration without a deployed CP). Pairs
    with the same flag in `_handler.py` install routes."""
    if os.environ.get("GRAVEL_GH_DEV_STUB") == "1":
        owner = os.environ.get("GRAVEL_GH_DEV_REPO_OWNER")
        name = os.environ.get("GRAVEL_GH_DEV_REPO_NAME")
        if not owner or not name:
            return None
        return GhInstallState(
            installation_id=0,
            repo_owner=owner,
            repo_name=name,
            install_secret="dev-stub",
        )
    id_raw = os.environ.get("GRAVEL_GH_INSTALL_ID")
    secret = os.environ.get("GRAVEL_GH_INSTALL_SECRET")
    owner = os.environ.get("GRAVEL_GH_REPO_OWNER")
    name = os.environ.get("GRAVEL_GH_REPO_NAME")
    if not id_raw or not secret or not owner or not name:
        return None
    try:
        installation_id = int(id_raw)
    except ValueError:
        return None
    if installation_id <= 0:
        return None
    return GhInstallState(
        installation_id=installation_id,
        repo_owner=owner,
        repo_name=name,
        install_secret=secret,
    )


def get_gh_install_state() -> GhInstallState | None:
    """Alias kept for parity with the TS surface. Pure env read; the
    async wrapper exists in TS to match call sites that awaited an old
    fetch-based version."""
    return read_gh_install_state_from_env()


def _control_plane_url() -> str:
    return os.environ.get("GRAVEL_CONTROL_PLANE_URL") or "https://gravel.artanis.ai"


@dataclass
class MintedInstallationToken:
    token: str
    expires_at: str
    repo_full_name: str | None


def mint_installation_token_via_cp(state: GhInstallState) -> MintedInstallationToken:
    """Ask the CP to mint a 1-hour repo-scoped GitHub installation token.

    Auth = `install_secret` from env (HMAC-verified server-side). Raises
    `RuntimeError` on any non-200 from the CP — caller turns that into a
    structured `github_token_mint_failed` response so the dashboard can
    distinguish "GH App not installed" from "GH App installed but CP
    rejected the secret"."""
    import json
    import urllib.error
    import urllib.request

    url = _control_plane_url().rstrip("/") + "/api/cli/github/installation-token"
    payload = json.dumps(
        {
            "installation_id": state.installation_id,
            "install_secret": state.install_secret,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                body = resp.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"installation-token mint failed: {resp.status} {body}")
            data: dict[str, Any] = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise RuntimeError(f"installation-token mint failed: {e.code} {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"installation-token mint failed: {e.reason}") from e
    token = data.get("token")
    expires = data.get("expires_at")
    if not isinstance(token, str) or not isinstance(expires, str):
        raise RuntimeError("installation-token mint returned an unexpected body shape")
    repo_full = data.get("repo_full_name")
    return MintedInstallationToken(
        token=token,
        expires_at=expires,
        repo_full_name=repo_full if isinstance(repo_full, str) else None,
    )
