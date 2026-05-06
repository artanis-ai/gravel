"""Tests for ``run_login`` — the lazy-auth path. Mirrors
packages/sdk-ts/tests/cli-login.test.ts.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from artanis_gravel.login import run_login
from artanis_gravel.wizard.oauth import WizardCredentials


def test_short_circuits_when_creds_already_in_env_local(tmp_path: Path) -> None:
    (tmp_path / ".env.local").write_text(
        "GRAVEL_PROJECT_ID=existing\nGRAVEL_API_KEY=existing\n", encoding="utf-8"
    )
    with patch(
        "artanis_gravel.login.browser_oauth_handshake",
        side_effect=AssertionError("OAuth must not run when env is configured"),
    ):
        summary = run_login(cwd=tmp_path, open_browser=False)
    assert summary["already_configured"] is True
    assert summary["env_file"] == ".env.local"


def test_short_circuits_when_creds_already_in_env(tmp_path: Path) -> None:
    (tmp_path / ".env").write_text(
        "GRAVEL_PROJECT_ID=existing\nGRAVEL_API_KEY=existing\n", encoding="utf-8"
    )
    with patch(
        "artanis_gravel.login.browser_oauth_handshake",
        side_effect=AssertionError("OAuth must not run when env is configured"),
    ):
        summary = run_login(cwd=tmp_path, open_browser=False)
    assert summary["already_configured"] is True
    assert summary["env_file"] == ".env"


def test_runs_oauth_and_writes_creds(tmp_path: Path) -> None:
    creds = WizardCredentials(
        project_id="proj_login_1",
        api_key="ak_login_1",
        project_name="Sandbox",
        organization_name="TestOrg",
    )

    async def fake_handshake(*_args: Any, **_kwargs: Any) -> WizardCredentials:
        return creds

    with patch("artanis_gravel.login.browser_oauth_handshake", side_effect=fake_handshake):
        summary = run_login(cwd=tmp_path, open_browser=False)

    assert summary["already_configured"] is False
    assert summary["project_id"] == "proj_login_1"
    assert summary["api_key"] == "ak_login_1"
    env_text = (tmp_path / ".env.local").read_text(encoding="utf-8")
    assert "GRAVEL_PROJECT_ID=proj_login_1" in env_text
    assert "GRAVEL_API_KEY=ak_login_1" in env_text


def test_oauth_failure_surfaces_as_runtime_error(tmp_path: Path) -> None:
    from artanis_gravel.wizard.oauth import OAuthError

    async def fake_handshake(*_args: Any, **_kwargs: Any) -> WizardCredentials:
        raise OAuthError("timeout")

    with patch("artanis_gravel.login.browser_oauth_handshake", side_effect=fake_handshake):
        with pytest.raises(RuntimeError, match="OAuth handshake failed"):
            run_login(cwd=tmp_path, open_browser=False)
