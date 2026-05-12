"""Tests for the Python ``doctor`` helper. Mirrors the TS doctor
tests so a Python user sees the right per-stack command and CI can
gate on the exit code without parsing output.

Covers:
- ``is_newer`` semver comparator across the realistic cases.
- ``update_command`` per package manager (uv / poetry / pipenv / pip).
- ``_detect_package_manager`` lockfile precedence.
- ``render_doctor`` output shape (hasUpdate / up-to-date / unknown).
"""
from __future__ import annotations

from pathlib import Path

from artanis_gravel.doctor import (
    VersionInfo,
    _detect_package_manager,
    is_newer,
    render_doctor,
    update_command,
)


class TestIsNewer:
    def test_patch_bumps(self) -> None:
        assert is_newer("0.1.0", "0.1.1") is True
        assert is_newer("0.1.1", "0.1.0") is False

    def test_minor_bumps(self) -> None:
        assert is_newer("0.1.5", "0.2.0") is True

    def test_major_bumps(self) -> None:
        assert is_newer("0.9.9", "1.0.0") is True

    def test_equal(self) -> None:
        assert is_newer("1.2.3", "1.2.3") is False

    def test_leading_v(self) -> None:
        assert is_newer("v0.1.0", "0.1.1") is True
        assert is_newer("0.1.0", "v0.1.1") is True

    def test_prerelease_stripped(self) -> None:
        # 0.1.0-rc.1 → 0.1.0 base; user already on 0.1.0 → no push.
        assert is_newer("0.1.0", "0.1.0-rc.1") is False
        assert is_newer("0.1.0-rc.1", "0.1.1") is True


class TestUpdateCommand:
    def test_uv(self) -> None:
        assert update_command("uv", "1.2.3") == "uv pip install --upgrade artanis-gravel==1.2.3"

    def test_poetry(self) -> None:
        assert update_command("poetry", "1.2.3") == "poetry add artanis-gravel@1.2.3"

    def test_pipenv(self) -> None:
        # pipenv has no per-version-target syntax.
        assert update_command("pipenv", "1.2.3") == "pipenv update artanis-gravel"

    def test_pip(self) -> None:
        assert update_command("pip", "1.2.3") == "pip install --upgrade artanis-gravel==1.2.3"

    def test_unknown_falls_back_to_pip(self) -> None:
        assert update_command("rye", "1.2.3").startswith("pip install --upgrade")


class TestDetectPackageManager:
    def test_uv_wins(self, tmp_path: Path) -> None:
        (tmp_path / "uv.lock").touch()
        assert _detect_package_manager(tmp_path) == "uv"

    def test_poetry(self, tmp_path: Path) -> None:
        (tmp_path / "poetry.lock").touch()
        assert _detect_package_manager(tmp_path) == "poetry"

    def test_pipenv(self, tmp_path: Path) -> None:
        (tmp_path / "Pipfile.lock").touch()
        assert _detect_package_manager(tmp_path) == "pipenv"

    def test_falls_back_to_pip(self, tmp_path: Path) -> None:
        assert _detect_package_manager(tmp_path) == "pip"

    def test_uv_beats_poetry(self, tmp_path: Path) -> None:
        # uv-lock and poetry-lock could both exist in a repo that's
        # migrating between managers. Document which wins.
        (tmp_path / "uv.lock").touch()
        (tmp_path / "poetry.lock").touch()
        assert _detect_package_manager(tmp_path) == "uv"


class TestRenderDoctor:
    def _info(self, **kw: object) -> VersionInfo:
        defaults = {
            "current": "0.1.0",
            "latest": "0.9.9",
            "has_update": True,
            "package_manager": "uv",
            "language": "python",
        }
        defaults.update(kw)
        return VersionInfo(**defaults)  # type: ignore[arg-type]

    def test_update_available_with_uv(self) -> None:
        out = render_doctor(self._info())
        assert "artanis-gravel 0.1.0" in out
        assert "stack: python (uv)" in out
        assert "Update available." in out
        assert "uv pip install --upgrade artanis-gravel==0.9.9" in out

    def test_up_to_date(self) -> None:
        out = render_doctor(self._info(has_update=False, latest="0.1.0"))
        assert "up to date" in out
        assert "Update available" not in out

    def test_unknown_latest(self) -> None:
        out = render_doctor(self._info(latest=None, has_update=False))
        assert "latest: (unknown" in out
        assert "Update available" not in out
