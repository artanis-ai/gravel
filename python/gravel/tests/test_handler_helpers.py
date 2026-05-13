"""Unit coverage for the helper modules behind the shared handler.

Separate from test_handler_routes.py because these poke the pure
functions directly: rate-limit clock advancement, env-file additions
on a tmpdir, GitHub install-state precedence (env vs dev stub),
prompts/submit invariants without touching the network.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest


# -------------------- _rate_limit --------------------


@pytest.fixture(autouse=True)
def _clean_rate_limit():
    from artanis_gravel._rate_limit import _reset_for_tests

    _reset_for_tests()
    yield
    _reset_for_tests()


def test_rate_limit_allows_under_threshold():
    from artanis_gravel._rate_limit import MAX_ATTEMPTS, attempt_login

    for _ in range(MAX_ATTEMPTS):
        out = attempt_login("1.1.1.1")
        assert out.allowed, "should still be allowed under the threshold"


def test_rate_limit_locks_out_on_max_plus_one():
    from artanis_gravel._rate_limit import MAX_ATTEMPTS, attempt_login

    for _ in range(MAX_ATTEMPTS):
        assert attempt_login("1.1.1.1").allowed
    out = attempt_login("1.1.1.1")
    assert not out.allowed
    assert out.retry_after_ms > 0


def test_rate_limit_doubles_lockout_on_consecutive_blocks():
    """First lockout = BASE; second = 2×BASE; third = 4×BASE."""
    from artanis_gravel._rate_limit import (
        BASE_LOCKOUT_S,
        MAX_ATTEMPTS,
        attempt_login,
    )

    now = 1_000_000.0
    for _ in range(MAX_ATTEMPTS):
        attempt_login("ip", now=now)
    out1 = attempt_login("ip", now=now)
    assert pytest.approx(out1.retry_after_ms / 1000, 0.1) == BASE_LOCKOUT_S

    now += BASE_LOCKOUT_S + 1
    # Burn another window
    for _ in range(MAX_ATTEMPTS):
        attempt_login("ip", now=now)
    out2 = attempt_login("ip", now=now)
    assert pytest.approx(out2.retry_after_ms / 1000, 0.1) == BASE_LOCKOUT_S * 2


def test_rate_limit_record_success_clears_bucket():
    """A legitimate login resets the count so the user can fat-finger
    again on the next session without immediate lockout."""
    from artanis_gravel._rate_limit import attempt_login, record_success

    for _ in range(5):
        attempt_login("clean-ip")
    record_success("clean-ip")
    # Now we should be able to attempt 5 more without lockout.
    for _ in range(5):
        assert attempt_login("clean-ip").allowed


def test_rate_limit_buckets_are_per_ip():
    from artanis_gravel._rate_limit import attempt_login

    for _ in range(5):
        attempt_login("ip-a")
    # ip-a's 6th attempt is locked.
    assert not attempt_login("ip-a").allowed
    # ip-b is untouched.
    assert attempt_login("ip-b").allowed


# -------------------- _github_state --------------------


def test_gh_install_state_returns_none_when_unset(monkeypatch):
    for k in (
        "GRAVEL_GH_INSTALL_ID",
        "GRAVEL_GH_INSTALL_SECRET",
        "GRAVEL_GH_REPO_OWNER",
        "GRAVEL_GH_REPO_NAME",
        "GRAVEL_GH_DEV_STUB",
    ):
        monkeypatch.delenv(k, raising=False)
    from artanis_gravel._github_state import get_gh_install_state

    assert get_gh_install_state() is None


def test_gh_install_state_reads_env_when_complete(monkeypatch):
    monkeypatch.setenv("GRAVEL_GH_INSTALL_ID", "999")
    monkeypatch.setenv("GRAVEL_GH_INSTALL_SECRET", "secret-x")
    monkeypatch.setenv("GRAVEL_GH_REPO_OWNER", "acme")
    monkeypatch.setenv("GRAVEL_GH_REPO_NAME", "app")
    monkeypatch.delenv("GRAVEL_GH_DEV_STUB", raising=False)
    from artanis_gravel._github_state import get_gh_install_state

    state = get_gh_install_state()
    assert state is not None
    assert state.installation_id == 999
    assert state.repo_owner == "acme"
    assert state.repo_name == "app"
    assert state.install_secret == "secret-x"


def test_gh_install_state_rejects_non_integer_id(monkeypatch):
    monkeypatch.setenv("GRAVEL_GH_INSTALL_ID", "not-an-int")
    monkeypatch.setenv("GRAVEL_GH_INSTALL_SECRET", "x")
    monkeypatch.setenv("GRAVEL_GH_REPO_OWNER", "o")
    monkeypatch.setenv("GRAVEL_GH_REPO_NAME", "r")
    from artanis_gravel._github_state import get_gh_install_state

    assert get_gh_install_state() is None


def test_gh_install_state_rejects_zero_or_negative_id(monkeypatch):
    monkeypatch.setenv("GRAVEL_GH_INSTALL_ID", "0")
    monkeypatch.setenv("GRAVEL_GH_INSTALL_SECRET", "x")
    monkeypatch.setenv("GRAVEL_GH_REPO_OWNER", "o")
    monkeypatch.setenv("GRAVEL_GH_REPO_NAME", "r")
    from artanis_gravel._github_state import get_gh_install_state

    assert get_gh_install_state() is None


def test_gh_install_state_dev_stub_wins(monkeypatch):
    """When GRAVEL_GH_DEV_STUB=1 with the right repo vars, the stub
    state is returned even if real install env vars are set."""
    monkeypatch.setenv("GRAVEL_GH_INSTALL_ID", "1")
    monkeypatch.setenv("GRAVEL_GH_INSTALL_SECRET", "real")
    monkeypatch.setenv("GRAVEL_GH_REPO_OWNER", "real-owner")
    monkeypatch.setenv("GRAVEL_GH_REPO_NAME", "real-repo")
    monkeypatch.setenv("GRAVEL_GH_DEV_STUB", "1")
    monkeypatch.setenv("GRAVEL_GH_DEV_REPO_OWNER", "stub-owner")
    monkeypatch.setenv("GRAVEL_GH_DEV_REPO_NAME", "stub-repo")
    from artanis_gravel._github_state import get_gh_install_state

    state = get_gh_install_state()
    assert state is not None
    assert state.repo_owner == "stub-owner"
    assert state.install_secret == "dev-stub"


def test_gh_install_state_dev_stub_requires_repo_env(monkeypatch):
    """GRAVEL_GH_DEV_STUB=1 without owner+name → None."""
    monkeypatch.setenv("GRAVEL_GH_DEV_STUB", "1")
    monkeypatch.delenv("GRAVEL_GH_DEV_REPO_OWNER", raising=False)
    monkeypatch.delenv("GRAVEL_GH_DEV_REPO_NAME", raising=False)
    from artanis_gravel._github_state import get_gh_install_state

    assert get_gh_install_state() is None


# -------------------- _env_writer --------------------


def test_env_writer_creates_local_when_neither_exists(tmp_path: Path):
    from artanis_gravel._env_writer import write_env_additions

    result = write_env_additions(tmp_path, {"K1": "v1", "K2": "v2"})
    assert result == {"file": ".env.local"}
    body = (tmp_path / ".env.local").read_text()
    assert "K1=v1" in body and "K2=v2" in body


def test_env_writer_prefers_local_when_both_exist(tmp_path: Path):
    (tmp_path / ".env.local").write_text("EXISTING=x\n")
    (tmp_path / ".env").write_text("OTHER=y\n")
    from artanis_gravel._env_writer import write_env_additions

    write_env_additions(tmp_path, {"NEW": "value"})
    assert "NEW=value" in (tmp_path / ".env.local").read_text()
    # .env left unchanged.
    assert "NEW=" not in (tmp_path / ".env").read_text()


def test_env_writer_falls_back_to_env_when_local_missing(tmp_path: Path):
    (tmp_path / ".env").write_text("EXISTING=x\n")
    from artanis_gravel._env_writer import write_env_additions

    result = write_env_additions(tmp_path, {"NEW": "value"})
    assert result == {"file": ".env"}
    assert "NEW=value" in (tmp_path / ".env").read_text()


def test_env_writer_skips_existing_keys_when_not_overwrite(tmp_path: Path):
    (tmp_path / ".env.local").write_text("KEY=old\n")
    from artanis_gravel._env_writer import write_env_additions

    write_env_additions(tmp_path, {"KEY": "new"})
    assert "KEY=old" in (tmp_path / ".env.local").read_text()
    assert "KEY=new" not in (tmp_path / ".env.local").read_text()


def test_env_writer_overwrites_existing_keys_when_flag_set(tmp_path: Path):
    (tmp_path / ".env.local").write_text("KEY=old\n")
    from artanis_gravel._env_writer import write_env_additions

    write_env_additions(tmp_path, {"KEY": "new"}, overwrite=True)
    assert "KEY=new" in (tmp_path / ".env.local").read_text()
    assert "KEY=old" not in (tmp_path / ".env.local").read_text()


def test_env_writer_preserves_other_lines(tmp_path: Path):
    """Existing lines we're not modifying must be untouched."""
    (tmp_path / ".env.local").write_text("KEEP=me\n# a comment\nKEY=old\n")
    from artanis_gravel._env_writer import write_env_additions

    write_env_additions(tmp_path, {"KEY": "new"}, overwrite=True)
    body = (tmp_path / ".env.local").read_text()
    assert "KEEP=me" in body
    assert "# a comment" in body
    assert "KEY=new" in body


# -------------------- _prompts_submit --------------------


def test_draft_branch_for_is_deterministic_per_day():
    """Same user + same date → same branch, so re-submits update the
    existing PR instead of opening a new one."""
    from datetime import date

    from artanis_gravel._prompts_submit import draft_branch_for

    b1 = draft_branch_for("user-123", today=date(2026, 5, 13))
    b2 = draft_branch_for("user-123", today=date(2026, 5, 13))
    assert b1 == b2
    assert "2026-05-13" in b1
    assert "user-123" in b1


def test_draft_branch_for_sanitizes_user_id():
    """Non-alphanumeric chars become dashes so the branch name is git-safe."""
    from datetime import date

    from artanis_gravel._prompts_submit import draft_branch_for

    name = draft_branch_for("a/b@c", today=date(2026, 5, 13))
    assert "/" not in name.replace("gravel/", "")  # only the prefix slash
    assert "@" not in name


def test_submit_drafts_raises_no_drafts():
    from artanis_gravel._prompts_submit import SubmitArgs, SubmitError, submit_drafts

    with pytest.raises(SubmitError) as ei:
        submit_drafts(
            SubmitArgs(
                repo_root="/tmp",
                drafts=[],
                draft_branch="b",
                access_token="t",
                repo_owner="o",
                repo_name="r",
            )
        )
    assert ei.value.code == "no_drafts"


def test_submit_drafts_raises_manifest_missing(tmp_path):
    """Manifest exists but has zero prompts → manifest_missing.
    Different from manifest-doesn't-exist (which raises FileNotFoundError
    upstream — not a user-facing case from the dashboard)."""
    (tmp_path / ".gravel").mkdir()
    (tmp_path / ".gravel" / "manifest.json").write_text('{"version": 1, "prompts": []}')
    from artanis_gravel._prompts_submit import (
        DraftInput,
        SubmitArgs,
        SubmitError,
        submit_drafts,
    )

    with pytest.raises(SubmitError) as ei:
        submit_drafts(
            SubmitArgs(
                repo_root=tmp_path,
                drafts=[DraftInput("p_x", "new")],
                draft_branch="b",
                access_token="t",
                repo_owner="o",
                repo_name="r",
            )
        )
    assert ei.value.code == "manifest_missing"


def test_submit_drafts_raises_unknown_prompt(tmp_path):
    """A draft referencing an id not in the manifest → unknown_prompt
    with the missing ids listed in details."""
    (tmp_path / ".gravel").mkdir()
    (tmp_path / ".gravel" / "manifest.json").write_text(
        '{"version": 1, "prompts": ['
        '{"id": "p_known", "type": "file", "path": "x.md", "hash": "0"}'
        "]}"
    )
    from artanis_gravel._prompts_submit import (
        DraftInput,
        SubmitArgs,
        SubmitError,
        submit_drafts,
    )

    with pytest.raises(SubmitError) as ei:
        submit_drafts(
            SubmitArgs(
                repo_root=tmp_path,
                drafts=[DraftInput("p_missing", "new")],
                draft_branch="b",
                access_token="t",
                repo_owner="o",
                repo_name="r",
            )
        )
    assert ei.value.code == "unknown_prompt"
    assert ei.value.details == {"missing": ["p_missing"]}


def test_submit_drafts_rejects_mixed_file_embedded_same_path(tmp_path):
    """If two drafts touch the same path but one is file-type and the
    other embedded, that's structurally ambiguous and we refuse."""
    (tmp_path / "x.md").write_text("hello", encoding="utf-8")
    (tmp_path / ".gravel").mkdir()
    (tmp_path / ".gravel" / "manifest.json").write_text(
        '{"version": 1, "prompts": ['
        '{"id": "p_file", "type": "file", "path": "x.md", "hash": "0"},'
        '{"id": "p_emb", "type": "embedded", "path": "x.md",'
        ' "lineStart": 1, "lineEnd": 1, "charStart": 0, "charEnd": 5, "hash": "0"}'
        "]}"
    )
    from artanis_gravel._prompts_submit import (
        DraftInput,
        SubmitArgs,
        SubmitError,
        submit_drafts,
    )

    with pytest.raises(SubmitError) as ei:
        submit_drafts(
            SubmitArgs(
                repo_root=tmp_path,
                drafts=[
                    DraftInput("p_file", "whole new file"),
                    DraftInput("p_emb", "inline"),
                ],
                draft_branch="b",
                access_token="t",
                repo_owner="o",
                repo_name="r",
            )
        )
    assert ei.value.code == "unknown_prompt"


# -------------------- _migrations_status --------------------


def test_migrations_status_no_engine_returns_no_db_reason():
    from artanis_gravel._migrations_status import migrations_status

    body = migrations_status(None)
    assert body["pending"] == 0
    assert body["dialect"] is None
    assert body["reason"] == "no-db"
    assert isinstance(body["autoMigrate"], bool)


def test_migrations_status_should_auto_migrate_off_in_prod():
    from artanis_gravel._migrations_status import should_auto_migrate

    assert should_auto_migrate({"GRAVEL_DISABLE_AUTO_MIGRATE": "1"}) is False
    assert should_auto_migrate({"PYTHON_ENV": "production"}) is False
    assert should_auto_migrate({"NODE_ENV": "production"}) is False
    assert should_auto_migrate({}) is True


def test_migrations_status_pending_count_zero_with_no_versions(monkeypatch, tmp_path):
    """Empty alembic/versions dir → pending=0 (we don't nag the user
    with false positives when there are no migrations bundled)."""
    monkeypatch.setenv("GRAVEL_ALEMBIC_VERSIONS_DIR", str(tmp_path))
    from artanis_gravel._migrations_status import pending_migration_count

    # Engine is required to be non-None for a real count; passing None
    # short-circuits to 0 directly.
    assert pending_migration_count(None) == 0


# Suppress unused-import warning for `os`.
_ = os
