"""Integration test for run_wizard / init().

The CLI is always local — sign-in lives in the dashboard. We exercise:
  - default install (no creds in .env, fully offline)
  - api_key + project flag path (creds baked into .env)
  - env-var fallback for the same flag path
"""
from __future__ import annotations

from pathlib import Path

import pytest

from artanis_gravel.wizard import init, run_wizard


def _bare_python_project(root: Path) -> None:
    (root / "pyproject.toml").write_text(
        "[project]\nname = 'demo'\nversion = '0.1.0'\ndependencies = ['fastapi']\n",
        encoding="utf-8",
    )
    (root / "main.py").write_text(
        "from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get('/')\nasync def root():\n    return {'ok': True}\n",
        encoding="utf-8",
    )


def test_default_install_is_local(tmp_path: Path) -> None:
    """No flags, no env: runs fully local — no creds in .env, no network."""
    _bare_python_project(tmp_path)

    summary = run_wizard(
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
    )

    assert summary["auth_mode"] == "local"
    assert summary["api_key"] is None
    assert summary["project_id"] is None

    env_text = (tmp_path / ".env.local").read_text(encoding="utf-8")
    assert "GRAVEL_API_KEY" not in env_text
    assert "GRAVEL_PROJECT_ID" not in env_text
    assert "GRAVEL_ADMIN_PASSWORD=" in env_text

    pw_line = next(line for line in env_text.splitlines() if line.startswith("GRAVEL_ADMIN_PASSWORD="))
    pw = pw_line.split("=", 1)[1]
    assert len(pw) == 32

    cfg_file = tmp_path / "gravel_config.py"
    assert cfg_file.exists()
    cfg_text = cfg_file.read_text(encoding="utf-8")
    assert "GravelConfig" in cfg_text
    assert "/admin/ai" in cfg_text

    assert (tmp_path / "gravel_route.py").exists()


def test_flags_path_bakes_creds_into_env(tmp_path: Path) -> None:
    """Passing api_key + project drops them straight into .env."""
    _bare_python_project(tmp_path)

    summary = run_wizard(
        api_key="ak_test",
        project_id="proj_xxx",
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
    )

    assert summary["auth_mode"] == "flags"
    assert summary["api_key"] == "ak_test"
    assert summary["project_id"] == "proj_xxx"

    env_text = (tmp_path / ".env.local").read_text(encoding="utf-8")
    assert "GRAVEL_API_KEY=ak_test" in env_text
    assert "GRAVEL_PROJECT_ID=proj_xxx" in env_text
    assert "GRAVEL_ADMIN_PASSWORD=" in env_text


def test_skipping_deep_scan_and_trace_emits_blockers(tmp_path: Path) -> None:
    _bare_python_project(tmp_path)
    summary = run_wizard(
        api_key="ak_test",
        project_id="proj_xxx",
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
    )
    assert any("Deep prompt scan" in b for b in summary["blockers"])
    assert any("Test trace" in b for b in summary["blockers"])


def test_init_alias_matches_run_wizard(tmp_path: Path) -> None:
    _bare_python_project(tmp_path)
    summary = init(
        api_key="ak_alias",
        project_id="proj_alias",
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
    )
    assert summary["api_key"] == "ak_alias"
    assert summary["project_id"] == "proj_alias"


def test_libcst_inject_router_into_main(tmp_path: Path) -> None:
    _bare_python_project(tmp_path)
    run_wizard(
        api_key="ak_test",
        project_id="proj_xxx",
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
    )
    main_text = (tmp_path / "main.py").read_text(encoding="utf-8")
    assert "gravel_route" in main_text
    assert "include_router" in main_text
    assert "/admin/ai" in main_text
    assert (tmp_path / "main.py.gravel.bak").exists()


def test_existing_env_preserved(tmp_path: Path) -> None:
    _bare_python_project(tmp_path)
    (tmp_path / ".env").write_text("EXISTING=keep\n", encoding="utf-8")
    run_wizard(
        api_key="ak_test",
        project_id="proj_xxx",
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
    )
    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "EXISTING=keep" in env_text
    assert "GRAVEL_API_KEY=ak_test" in env_text


@pytest.mark.parametrize("flag", ["api_key", "project_id"])
def test_env_fallback_works_when_flags_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, flag: str
) -> None:
    """If api_key+project come from env vars, they get baked into .env."""
    _bare_python_project(tmp_path)
    monkeypatch.setenv("GRAVEL_API_KEY", "env_ak")
    monkeypatch.setenv("GRAVEL_PROJECT_ID", "env_proj")
    summary = run_wizard(
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
    )
    assert summary["auth_mode"] == "flags"
    assert summary["api_key"] == "env_ak"
    assert summary["project_id"] == "env_proj"


def test_only_api_key_without_project_falls_back_to_local(tmp_path: Path) -> None:
    """Half-set creds shouldn't accidentally trigger flags mode."""
    _bare_python_project(tmp_path)
    summary = run_wizard(
        api_key="ak_orphan",
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
    )
    assert summary["auth_mode"] == "local"
    assert summary["api_key"] is None
    assert summary["project_id"] is None
