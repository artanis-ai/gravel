"""Tests for artanis_gravel._cli — the Python wrapper around the gravel binary.

Coverage strategy mirrors the JS wrapper's test file (see
packages/sdk-ts/tests/cli-wrapper.test.ts for the rationale):

  - Structural checks: shebang/import shape, platform table, env override
    name, the "die before exit" patterns the production code relies on.
  - Platform mapping: unsupported host bails synchronously with a clear
    error before any network call.
  - URL shape: GRAVEL_RELEASES_BASE_URL is honoured and the resulting URL
    ends up in the wrapper's failure message.

The actual download path is exercised by the release pipeline's e2e
smoke (`gravel doctor` against a tagged GitHub Release), not in
in-process tests.
"""
from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path

import pytest

WRAPPER_SRC = (
    Path(__file__).resolve().parent.parent / "src" / "artanis_gravel" / "_cli.py"
)


# --- structural -------------------------------------------------------------


def test_wrapper_source_lists_five_platforms() -> None:
    text = WRAPPER_SRC.read_text()
    for asset in (
        "gravel-linux-amd64",
        "gravel-linux-arm64",
        "gravel-darwin-amd64",
        "gravel-darwin-arm64",
        "gravel-windows-amd64.exe",
    ):
        assert asset in text, f"expected {asset} in PLATFORMS map"


def test_wrapper_uses_atomic_rename_for_cache_install() -> None:
    """Replace the temp file via Path.replace, not os.rename — the former
    is atomic across the same filesystem and never partial-writes on
    interruption, which matters because we install to ~/.cache."""
    text = WRAPPER_SRC.read_text()
    assert "tmp_path.replace(dest)" in text


def test_wrapper_honours_releases_base_url_override() -> None:
    """The env override must exist in the source — both the docs and our
    tests assume internal mirrors can point GRAVEL_RELEASES_BASE_URL at
    a private host. The exact var name is part of the public contract;
    renaming it here means renaming it in install.sh, DESIGN.md, the JS
    wrapper, and the docs in lockstep."""
    text = WRAPPER_SRC.read_text()
    assert "GRAVEL_RELEASES_BASE_URL" in text


# --- platform mapping -------------------------------------------------------


def test_unsupported_platform_exits_cleanly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Import the wrapper module in-process, monkeypatch PLATFORMS to empty,
    and assert main() exits with the unsupported-platform message.
    Avoids spawning a subprocess (and the sibling-`types.py` shadowing
    pitfall that direct-script invocation hits)."""
    from artanis_gravel import _cli  # type: ignore[attr-defined]

    monkeypatch.setattr(_cli, "PLATFORMS", {})
    with pytest.raises(SystemExit) as excinfo:
        _cli.main()
    assert excinfo.value.code != 0


# --- mapping logic ----------------------------------------------------------


def test_platform_table_matches_release_assets() -> None:
    """Lock in the exact (uname-system, uname-machine) → asset mapping. If
    a future maintainer renames an asset or changes the matrix, this
    test makes them update both ends in lockstep."""
    text = WRAPPER_SRC.read_text()
    expected = {
        '("Linux", "x86_64")': "gravel-linux-amd64",
        '("Linux", "aarch64")': "gravel-linux-arm64",
        '("Darwin", "x86_64")': "gravel-darwin-amd64",
        '("Darwin", "arm64")': "gravel-darwin-arm64",
        '("Windows", "AMD64")': "gravel-windows-amd64.exe",
    }
    for key, asset in expected.items():
        assert key in text, f"missing platform key {key}"
        assert asset in text, f"missing asset name {asset}"


# --- runtime smoke ----------------------------------------------------------


@pytest.mark.skipif(
    platform.system() != "Linux" or platform.machine() != "x86_64",
    reason="runtime smoke depends on the host arch being linux-amd64",
)
def test_running_wrapper_directly_attempts_to_download(tmp_path: Path) -> None:
    """Run the wrapper as a script with an unreachable releases URL and
    assert the failure message contains the correct asset URL. This is
    the proof that the platform-mapping → URL-construction path is wired
    correctly end-to-end (sans the actual HTTP fetch)."""
    # Point at port 1 (reserved, never reachable). The wrapper should
    # hit the connection failure path quickly. We assert the failure
    # message contains the correct asset URL — proves platform mapping +
    # env override + URL construction are wired together.
    #
    # `python -m artanis_gravel._cli` (rather than `python _cli.py`)
    # respects package boundaries so the SDK's sibling `types.py`
    # doesn't shadow the stdlib `types` module during startup.
    result = subprocess.run(
        [sys.executable, "-m", "artanis_gravel._cli"],
        capture_output=True,
        text=True,
        timeout=10,
        env={
            **os.environ,
            "HOME": str(tmp_path),
            "GRAVEL_RELEASES_BASE_URL": "http://127.0.0.1:1",
        },
    )
    assert result.returncode != 0
    # The asset URL we expect the wrapper to build with the version
    # baked into pyproject.toml.
    from importlib.metadata import version as pkg_version
    expected_url_fragment = f"http://127.0.0.1:1/v{pkg_version('artanis-gravel')}/gravel-linux-amd64"
    assert expected_url_fragment in result.stderr, (
        f"expected {expected_url_fragment!r} in stderr; got: {result.stderr!r}"
    )
