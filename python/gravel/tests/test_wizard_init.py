"""Integration test for run_wizard / init() — explicit-credential path.

Avoids OAuth entirely by passing api_key + project. Disables --no-migrate
(no DATABASE_URL on test boxes), --no-hook (no git repo), --no-deep-scan,
and --no-test-trace (both are TODOs that always blocker-out).
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


def test_writes_env_and_config(tmp_path: Path) -> None:
    _bare_python_project(tmp_path)

    summary = run_wizard(
        api_key="ak_test",
        project_id="proj_xxx",
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
        ci=True,  # avoid attempting OAuth even if env stripping ever changes
    )

    env_file = tmp_path / ".env.local"
    assert env_file.exists(), "wizard should write .env.local when neither .env nor .env.local exists"
    env_text = env_file.read_text(encoding="utf-8")
    assert "GRAVEL_API_KEY=ak_test" in env_text
    assert "GRAVEL_PROJECT_ID=proj_xxx" in env_text
    assert "GRAVEL_ADMIN_PASSWORD=" in env_text

    # Random 32-char password (D-Q70).
    pw_line = next(line for line in env_text.splitlines() if line.startswith("GRAVEL_ADMIN_PASSWORD="))
    pw = pw_line.split("=", 1)[1]
    assert len(pw) == 32

    cfg_file = tmp_path / "gravel_config.py"
    assert cfg_file.exists()
    cfg_text = cfg_file.read_text(encoding="utf-8")
    assert "GravelConfig" in cfg_text
    assert "/admin/ai" in cfg_text

    # FastAPI route shim should have been emitted.
    assert (tmp_path / "gravel_route.py").exists()

    assert summary["api_key"] == "ak_test"
    assert summary["project_id"] == "proj_xxx"
    assert summary["password_generated"] == pw
    # With all skip flags, no blockers should fire on the happy path.
    assert summary["blockers"] == [], f"unexpected blockers: {summary['blockers']}"


def test_skipping_deep_scan_and_trace_emits_blockers(tmp_path: Path) -> None:
    _bare_python_project(tmp_path)
    summary = run_wizard(
        api_key="ak_test",
        project_id="proj_xxx",
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        ci=True,
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
        ci=True,
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
        ci=True,
    )
    main_text = (tmp_path / "main.py").read_text(encoding="utf-8")
    assert "gravel_route" in main_text
    assert "include_router" in main_text
    assert "/admin/ai" in main_text
    # Backup created.
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
        ci=True,
    )
    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "EXISTING=keep" in env_text
    assert "GRAVEL_API_KEY=ak_test" in env_text


@pytest.mark.parametrize("flag", ["api_key", "project_id"])
def test_env_fallback_works_when_one_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, flag: str
) -> None:
    """If api_key+project come from env vars, OAuth should be skipped."""
    _bare_python_project(tmp_path)
    monkeypatch.setenv("GRAVEL_API_KEY", "env_ak")
    monkeypatch.setenv("GRAVEL_PROJECT_ID", "env_proj")
    summary = run_wizard(
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
        ci=True,
    )
    assert summary["api_key"] == "env_ak"
    assert summary["project_id"] == "env_proj"


def test_local_mode_skips_cloud_creds(tmp_path: Path) -> None:
    """``--local`` should run the install but omit cloud creds from .env."""
    _bare_python_project(tmp_path)
    summary = run_wizard(
        cwd=tmp_path,
        local=True,
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


def test_non_tty_defaults_to_local(tmp_path: Path) -> None:
    """Non-TTY callers should not silently phone home — they get local mode."""
    _bare_python_project(tmp_path)
    summary = run_wizard(
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
        prompt_is_tty=False,
    )
    assert summary["auth_mode"] == "local"
    assert summary["api_key"] is None


def test_interactive_prompt_default_is_local(tmp_path: Path) -> None:
    """Hitting Enter at the prompt should land the user in local mode."""
    import io

    _bare_python_project(tmp_path)
    summary = run_wizard(
        cwd=tmp_path,
        no_migrate=True,
        no_hook=True,
        no_deep_scan=True,
        no_test_trace=True,
        prompt_is_tty=True,
        prompt_input=io.StringIO("\n"),
    )
    assert summary["auth_mode"] == "local"
    assert summary["api_key"] is None
    assert summary["project_id"] is None
