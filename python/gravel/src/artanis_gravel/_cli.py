# =============================================================================
# artanis_gravel._cli — Python wrapper around the gravel CLI binary.
# =============================================================================
#
# The real wizard lives in a single Go binary published per platform at
#   https://github.com/artanis-ai/gravel/releases/download/v<X>/gravel-<os>-<arch>
#
# This file is the PyPI-side door: read it before you trust it. ~100 lines of
# straightforward Python, no obfuscation, no install hooks.
#
# What it does, in order:
#   1. Read the package's installed version via importlib.metadata so we
#      always fetch the binary that matches the SDK semver in the user's
#      project. Lockstep is enforced by the release pipeline.
#   2. Detect OS + arch via platform.system() / platform.machine(). Map to
#      the release asset name (e.g. "gravel-linux-amd64").
#   3. Look in ~/.cache/artanis-gravel/v<version>/ for a cached copy.
#      Hit → skip download. Miss → fetch + sha256-verify + persist.
#   4. os.execv (POSIX) or subprocess.call (Windows) the binary with the
#      user's argv, propagate the exit code.
#
# What it does NOT do:
#   - No setup.py install hooks. `pip install artanis-gravel` doesn't fetch
#     the binary; only `gravel <cmd>` does, on first invocation.
#   - No registry detection / token exchange / OIDC fingerprinting.
#   - No anonymous analytics.
#   - No writes outside the user's $HOME cache directory.
#
# Source: https://github.com/artanis-ai/gravel/blob/main/python/gravel/src/artanis_gravel/_cli.py
# Architecture: https://github.com/artanis-ai/gravel/blob/main/cli/DESIGN.md
# =============================================================================
from __future__ import annotations

import hashlib
import os
import platform
import sys
import tempfile
import urllib.request
from importlib.metadata import version as pkg_version
from pathlib import Path
from typing import Tuple

REPO = "artanis-ai/gravel"

# Map (platform.system(), platform.machine()) -> GH Release asset name.
# Mirrors the JS wrapper byte-for-byte so both wrappers exec the same
# binary across stacks; lockstep is verified by the release matrix.
PLATFORMS: dict[Tuple[str, str], str] = {
    ("Linux", "x86_64"): "gravel-linux-amd64",
    ("Linux", "aarch64"): "gravel-linux-arm64",
    ("Darwin", "x86_64"): "gravel-darwin-amd64",
    ("Darwin", "arm64"): "gravel-darwin-arm64",
    ("Windows", "AMD64"): "gravel-windows-amd64.exe",
}


def main() -> None:
    """Entry point registered as `gravel` via [project.scripts] in pyproject.toml."""
    asset = _platform_asset()
    version = f"v{pkg_version('artanis-gravel')}"
    cache_dir = Path.home() / ".cache" / "artanis-gravel" / version
    bin_path = cache_dir / asset

    if not bin_path.exists():
        _download_and_verify(version, asset, bin_path)

    bin_path.chmod(0o755)
    args = [str(bin_path), *sys.argv[1:]]

    if os.name == "nt":
        # os.execv exists on Windows but has subtle process-replacement
        # semantics that can break terminal cleanup. Use subprocess.call
        # for a clean exit-code propagation path.
        import subprocess
        sys.exit(subprocess.call(args))
    os.execv(str(bin_path), args)


def _platform_asset() -> str:
    key = (platform.system(), platform.machine())
    asset = PLATFORMS.get(key)
    if asset is None:
        _die(
            f"unsupported platform '{key[0]}/{key[1]}'. "
            f"See https://github.com/{REPO}/releases for available binaries."
        )
    return asset


def _download_and_verify(version: str, asset: str, dest: Path) -> None:
    print(f"[gravel] fetching {asset} {version}…", file=sys.stderr)
    dest.parent.mkdir(parents=True, exist_ok=True)

    # GRAVEL_RELEASES_BASE_URL overrides the GH Release base, both for
    # tests and for users who mirror the assets internally. Should NOT
    # include the version; we append it ourselves so a mirror serves
    # `<base>/v0.4.0/gravel-<os>-<arch>` etc. Mirrors the JS wrapper's
    # contract so both stacks honour the same env var.
    base_root = os.environ.get(
        "GRAVEL_RELEASES_BASE_URL",
        f"https://github.com/{REPO}/releases/download",
    )
    base = f"{base_root}/{version}"
    sha_url = f"{base}/{asset}.sha256"
    bin_url = f"{base}/{asset}"

    try:
        expected_sha = _get_text(sha_url).split()[0].strip().lower()
    except Exception as e:  # noqa: BLE001 — we want to wrap all transport errors
        _die(f"couldn't fetch {sha_url}: {e}")
    if not _is_hex64(expected_sha):
        _die(f"malformed sha256 from {sha_url}: {expected_sha!r}")

    # Stream the binary into a tmp file in the same dir as `dest` (same
    # filesystem → rename is atomic) and hash on the fly. Avoids holding
    # the full 17 MB in RAM and avoids a half-written binary in the cache
    # if the process is interrupted mid-download.
    sha = hashlib.sha256()
    tmp_fd, tmp_name = tempfile.mkstemp(prefix=asset + ".", dir=str(dest.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(tmp_fd, "wb") as tmp_f, urllib.request.urlopen(bin_url) as r:
            while True:
                chunk = r.read(1 << 20)  # 1 MiB
                if not chunk:
                    break
                tmp_f.write(chunk)
                sha.update(chunk)
        actual_sha = sha.hexdigest()
        if actual_sha != expected_sha:
            _die(
                f"sha256 mismatch for {asset}: "
                f"expected {expected_sha}, got {actual_sha}"
            )
        tmp_path.replace(dest)
        dest.chmod(0o755)
    except SystemExit:
        # _die() raises SystemExit; let it propagate without
        # rewriting the message. Still need to clean up the tmp file.
        tmp_path.unlink(missing_ok=True)
        raise
    except Exception as e:  # noqa: BLE001
        tmp_path.unlink(missing_ok=True)
        _die(f"couldn't fetch {bin_url}: {e}")
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _get_text(url: str) -> str:
    with urllib.request.urlopen(url) as r:
        return r.read().decode("utf-8")


def _is_hex64(s: str) -> bool:
    return len(s) == 64 and all(c in "0123456789abcdef" for c in s)


def _die(msg: str) -> None:
    print(f"[gravel] {msg}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
