"""Browser-OAuth handshake against the Gravel control plane.

Mirrors packages/sdk-ts/src/wizard/oauth.ts but with the live implementation —
the TS version is still a stub. The CLI:

    1. Generates a single-use, URL-safe token.
    2. Picks a free localhost port (the control plane just records it; we
       don't actually run a callback server in v0).
    3. POSTs ``/api/cli/auth/init`` with ``{token, redirect_port}``.
    4. Opens the user's default browser at ``/cli/auth?token=<token>``.
    5. Polls ``/api/cli/auth/claim`` every 1.5s for up to ``POLL_TIMEOUT``
       seconds (default 10 minutes).
    6. Returns the resolved credentials.
"""
from __future__ import annotations

import asyncio
import os
import secrets
import socket
import webbrowser
from dataclasses import dataclass

import httpx

DEFAULT_CONTROL_PLANE = "https://gravel.artanis.ai"
POLL_INTERVAL_SECONDS = 1.5
POLL_TIMEOUT_SECONDS = 600  # 10 minutes; matches the server-side TTL.


@dataclass(frozen=True)
class WizardCredentials:
    """Result of a successful OAuth handshake."""

    project_id: str
    api_key: str
    project_name: str | None = None
    organization_name: str | None = None


class OAuthError(RuntimeError):
    """Raised when the handshake cannot complete (timeout, expired, etc.)."""


def resolve_control_plane_url() -> str:
    """Return the control-plane base URL, honouring ``GRAVEL_CONTROL_PLANE_URL``."""
    return os.environ.get("GRAVEL_CONTROL_PLANE_URL", DEFAULT_CONTROL_PLANE)


def _generate_token() -> str:
    # ``token_urlsafe(32)`` returns ~43 chars of base64url; trim to 32 to match
    # the TS side / docs convention.
    return secrets.token_urlsafe(32)[:32]


def _pick_free_port() -> int:
    """Bind to port 0 to let the OS pick a free ephemeral port, then release it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("", 0))
        return sock.getsockname()[1]


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception:
        # Silently swallow — we still print the URL so the user can paste it.
        pass


async def browser_oauth_handshake(
    *,
    client: httpx.AsyncClient | None = None,
    control_plane_url: str | None = None,
    poll_interval: float = POLL_INTERVAL_SECONDS,
    timeout_seconds: float = POLL_TIMEOUT_SECONDS,
    open_browser: bool = True,
    print_fn=print,
) -> WizardCredentials:
    """Run the full OAuth handshake and return resolved credentials.

    Args:
        client: Optional pre-configured ``httpx.AsyncClient`` (used in tests).
        control_plane_url: Override for the base URL (defaults to env or prod).
        poll_interval: Seconds between claim polls.
        timeout_seconds: Hard ceiling on total polling time.
        open_browser: Set to ``False`` to suppress the ``webbrowser.open`` call.
        print_fn: Injection point for stdout (test override).

    Raises:
        OAuthError: On timeout, expired token, or unexpected server response.
    """
    base = (control_plane_url or resolve_control_plane_url()).rstrip("/")
    token = _generate_token()
    port = _pick_free_port()

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=30.0)

    try:
        init_resp = await client.post(
            f"{base}/api/cli/auth/init",
            json={"token": token, "redirect_port": port},
        )
        if init_resp.status_code >= 400:
            raise OAuthError(
                f"Failed to initiate auth handshake: HTTP {init_resp.status_code} {init_resp.text}"
            )

        auth_url = f"{base}/cli/auth?token={token}"
        print_fn(f"[gravel] Opening browser to authenticate: {auth_url}")
        print_fn("[gravel] If the browser does not open, copy/paste the URL above.")
        if open_browser:
            _open_browser(auth_url)

        return await _poll_claim(
            client,
            base,
            token,
            poll_interval=poll_interval,
            timeout_seconds=timeout_seconds,
        )
    finally:
        if owns_client:
            await client.aclose()


async def _poll_claim(
    client: httpx.AsyncClient,
    base: str,
    token: str,
    *,
    poll_interval: float,
    timeout_seconds: float,
) -> WizardCredentials:
    deadline = asyncio.get_event_loop().time() + timeout_seconds
    claim_url = f"{base}/api/cli/auth/claim"

    while True:
        resp = await client.get(claim_url, params={"token": token})
        status = resp.status_code

        if status == 200:
            data = resp.json()
            try:
                return WizardCredentials(
                    project_id=data["project_id"],
                    api_key=data["api_key"],
                    project_name=data.get("project_name"),
                    organization_name=data.get("organization_name"),
                )
            except KeyError as exc:
                raise OAuthError(
                    f"Claim response missing required field: {exc.args[0]}"
                ) from exc

        if status == 202:
            # Still pending — fall through to sleep.
            pass
        elif status == 410:
            raise OAuthError(
                "Auth token expired before the user completed sign-in. Re-run `gravel init`."
            )
        elif status == 404:
            raise OAuthError(
                "Auth token not found on control plane. Re-run `gravel init`."
            )
        else:
            raise OAuthError(
                f"Unexpected claim response: HTTP {status} {resp.text}"
            )

        if asyncio.get_event_loop().time() + poll_interval > deadline:
            raise OAuthError(
                f"Timed out after {timeout_seconds:.0f}s waiting for browser sign-in."
            )
        await asyncio.sleep(poll_interval)


__all__ = [
    "DEFAULT_CONTROL_PLANE",
    "OAuthError",
    "POLL_INTERVAL_SECONDS",
    "POLL_TIMEOUT_SECONDS",
    "WizardCredentials",
    "browser_oauth_handshake",
    "resolve_control_plane_url",
]
