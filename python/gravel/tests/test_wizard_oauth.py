"""Unit tests for artanis_gravel.wizard.oauth.browser_oauth_handshake."""
from __future__ import annotations

import re

import pytest
from pytest_httpx import HTTPXMock

from artanis_gravel.wizard.oauth import (
    OAuthError,
    WizardCredentials,
    browser_oauth_handshake,
    resolve_control_plane_url,
)

CONTROL_PLANE = "https://gravel.test"
INIT_URL = f"{CONTROL_PLANE}/api/cli/auth/init"
CLAIM_RE = re.compile(r"^https://gravel\.test/api/cli/auth/claim\?token=.+$")


def _silent(_msg: str) -> None:
    pass


@pytest.mark.asyncio
async def test_happy_path_returns_credentials(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=INIT_URL,
        method="POST",
        json={"ok": True, "expires_in_seconds": 600},
    )
    httpx_mock.add_response(
        url=CLAIM_RE,
        method="GET",
        json={
            "project_id": "proj_abc",
            "api_key": "ak_live_xyz",
            "project_name": "My App",
            "organization_name": "Acme",
        },
    )

    creds = await browser_oauth_handshake(
        control_plane_url=CONTROL_PLANE,
        poll_interval=0.0,
        timeout_seconds=5,
        open_browser=False,
        print_fn=_silent,
    )

    assert isinstance(creds, WizardCredentials)
    assert creds.project_id == "proj_abc"
    assert creds.api_key == "ak_live_xyz"
    assert creds.project_name == "My App"
    assert creds.organization_name == "Acme"

    init_req = httpx_mock.get_request(url=INIT_URL)
    assert init_req is not None
    import json

    parsed = json.loads(init_req.read())
    assert isinstance(parsed["token"], str) and len(parsed["token"]) > 16
    assert isinstance(parsed["redirect_port"], int) and parsed["redirect_port"] > 0


@pytest.mark.asyncio
async def test_pending_then_success(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=INIT_URL, method="POST", json={"ok": True, "expires_in_seconds": 600},
    )
    httpx_mock.add_response(
        method="GET", url=CLAIM_RE, status_code=202, json={"error": "pending"},
    )
    httpx_mock.add_response(
        method="GET", url=CLAIM_RE, status_code=202, json={"error": "pending"},
    )
    httpx_mock.add_response(
        method="GET", url=CLAIM_RE,
        status_code=200,
        json={"project_id": "proj_2", "api_key": "ak_2"},
    )

    creds = await browser_oauth_handshake(
        control_plane_url=CONTROL_PLANE,
        poll_interval=0.0,
        timeout_seconds=5,
        open_browser=False,
        print_fn=_silent,
    )
    assert creds.project_id == "proj_2"
    assert creds.api_key == "ak_2"
    assert creds.project_name is None
    assert creds.organization_name is None

    polls = httpx_mock.get_requests(url=CLAIM_RE)
    assert len(polls) == 3


@pytest.mark.asyncio
async def test_expired_raises(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=INIT_URL, method="POST", json={"ok": True, "expires_in_seconds": 600})
    httpx_mock.add_response(
        method="GET", url=CLAIM_RE, status_code=410, json={"error": "expired"},
    )

    with pytest.raises(OAuthError, match="expired"):
        await browser_oauth_handshake(
            control_plane_url=CONTROL_PLANE,
            poll_interval=0.0,
            timeout_seconds=5,
            open_browser=False,
            print_fn=_silent,
        )


@pytest.mark.asyncio
async def test_not_found_raises(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=INIT_URL, method="POST", json={"ok": True, "expires_in_seconds": 600})
    httpx_mock.add_response(
        method="GET", url=CLAIM_RE, status_code=404, json={"error": "not found"},
    )

    with pytest.raises(OAuthError, match="not found"):
        await browser_oauth_handshake(
            control_plane_url=CONTROL_PLANE,
            poll_interval=0.0,
            timeout_seconds=5,
            open_browser=False,
            print_fn=_silent,
        )


@pytest.mark.asyncio
async def test_init_failure_raises(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=INIT_URL, method="POST", status_code=500, json={"error": "boom"}
    )
    with pytest.raises(OAuthError, match="Failed to initiate"):
        await browser_oauth_handshake(
            control_plane_url=CONTROL_PLANE,
            poll_interval=0.0,
            timeout_seconds=5,
            open_browser=False,
            print_fn=_silent,
        )


@pytest.mark.asyncio
async def test_timeout_raises(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=INIT_URL, method="POST", json={"ok": True, "expires_in_seconds": 600})
    httpx_mock.add_response(
        method="GET", url=CLAIM_RE,
        status_code=202, json={"error": "pending"}, is_reusable=True,
    )

    with pytest.raises(OAuthError, match="Timed out"):
        await browser_oauth_handshake(
            control_plane_url=CONTROL_PLANE,
            poll_interval=0.05,
            timeout_seconds=0.01,
            open_browser=False,
            print_fn=_silent,
        )


def test_resolve_control_plane_url_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GRAVEL_CONTROL_PLANE_URL", raising=False)
    assert resolve_control_plane_url() == "https://gravel.artanis.ai"


def test_resolve_control_plane_url_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRAVEL_CONTROL_PLANE_URL", "http://localhost:9000")
    assert resolve_control_plane_url() == "http://localhost:9000"
