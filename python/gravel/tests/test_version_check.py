"""Coverage for artanis_gravel.version_check.

Mirrors the TS-side tests of handler/version.ts: comparator edge
cases, package-manager detection precedence, cache TTL, PyPI failure
handling, env-var opt-out, and the integrated get_version_info()
response shape that the dashboard's UpdateBanner consumes.
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from artanis_gravel import version_check as vc


@pytest.fixture(autouse=True)
def _clean_caches():
    """Every test gets a cold cache; the module is process-scoped."""
    vc._reset_cache_for_tests()
    yield
    vc._reset_cache_for_tests()


# --- _is_newer ----------------------------------------------------------

@pytest.mark.parametrize(
    "current,latest,want",
    [
        ("0.5.6", "0.5.7", True),
        ("0.5.7", "0.5.7", False),
        ("0.5.8", "0.5.7", False),
        ("0.5.0", "0.6.0", True),
        ("1.0.0", "0.99.99", False),
        ("0.5.7", "v0.5.8", True),  # leading-v tolerated
        # Pre-release suffixes are stripped before compare (matches TS).
        # Limitation: rc → stable on the SAME core won't trigger the
        # banner. The TS comparator has the same property.
        ("0.5.7-rc.1", "0.5.7", False),
        ("0.5.7", "0.5.7-rc.1", False),
        ("0.5.6-rc.1", "0.5.7", True),
        ("0.0.0-unknown", "0.5.7", True),  # sentinel current
    ],
)
def test_is_newer(current, latest, want):
    assert vc._is_newer(current, latest) is want


def test_parse_semver_handles_non_numeric_parts():
    """Best-effort: a non-numeric piece is treated as 0 so weird
    pre-release strings (like '1.0.0a2') still compare cleanly."""
    assert vc._parse_semver("1.0.0a2") == [1, 0, 0]
    assert vc._parse_semver("0.5.7") == [0, 5, 7]
    assert vc._parse_semver("v0.5.7") == [0, 5, 7]
    assert vc._parse_semver("0.5.7-rc1+build5") == [0, 5, 7]


# --- _detect_package_manager -------------------------------------------

def _make_root(tmp_path: Path, files: list[str]) -> Path:
    for name in files:
        (tmp_path / name).write_text("", encoding="utf-8")
    return tmp_path


def test_detect_uv(tmp_path):
    assert vc._detect_package_manager(_make_root(tmp_path, ["uv.lock"])) == "uv"


def test_detect_poetry(tmp_path):
    assert vc._detect_package_manager(_make_root(tmp_path, ["poetry.lock"])) == "poetry"


def test_detect_pipenv(tmp_path):
    assert vc._detect_package_manager(_make_root(tmp_path, ["Pipfile.lock"])) == "pipenv"


def test_detect_pip_default(tmp_path):
    """No lockfile at all → fall back to pip."""
    assert vc._detect_package_manager(tmp_path) == "pip"


def test_detect_precedence_uv_wins(tmp_path):
    """uv.lock present alongside poetry.lock → uv wins (matches TS)."""
    root = _make_root(tmp_path, ["uv.lock", "poetry.lock", "Pipfile.lock"])
    assert vc._detect_package_manager(root) == "uv"


# --- _fetch_latest_from_pypi -------------------------------------------

def test_fetch_disabled_via_env(monkeypatch):
    monkeypatch.setenv("GRAVEL_VERSION_CHECK_DISABLED", "1")
    assert vc._fetch_latest_from_pypi() is None


def test_fetch_returns_version_on_success(monkeypatch):
    """A normal 200 from PyPI yields the version string."""
    fake_body = b'{"info": {"version": "0.5.7"}}'

    class _Resp:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self): return fake_body

    def _fake_urlopen(_req, timeout=None):  # noqa: ARG001
        return _Resp()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    monkeypatch.delenv("GRAVEL_VERSION_CHECK_DISABLED", raising=False)
    assert vc._fetch_latest_from_pypi() == "0.5.7"


def test_fetch_returns_none_on_http_error(monkeypatch):
    """Non-200 from PyPI → None, not an exception."""
    class _Resp:
        status = 500
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self): return b""

    def _fake(_req, timeout=None):  # noqa: ARG001
        return _Resp()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", _fake)
    monkeypatch.delenv("GRAVEL_VERSION_CHECK_DISABLED", raising=False)
    assert vc._fetch_latest_from_pypi() is None


def test_fetch_returns_none_on_network_failure(monkeypatch):
    """Any exception from urlopen → None (network blocked, DNS, etc.)."""
    def _raise(*_args, **_kwargs):
        raise OSError("network unreachable")

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", _raise)
    monkeypatch.delenv("GRAVEL_VERSION_CHECK_DISABLED", raising=False)
    assert vc._fetch_latest_from_pypi() is None


def test_fetch_returns_none_when_body_missing_version(monkeypatch):
    """Malformed PyPI response (no info.version) → None, not KeyError."""
    class _Resp:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self): return b'{"info": {}}'

    def _fake(_req, timeout=None):  # noqa: ARG001
        return _Resp()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", _fake)
    monkeypatch.delenv("GRAVEL_VERSION_CHECK_DISABLED", raising=False)
    assert vc._fetch_latest_from_pypi() is None


# --- _get_latest cache behaviour ---------------------------------------

def test_get_latest_caches_within_interval(monkeypatch):
    """Two consecutive calls within CHECK_INTERVAL_S → one network hit."""
    calls = {"n": 0}

    def _fake_fetch():
        calls["n"] += 1
        return "0.5.7"

    monkeypatch.setattr(vc, "_fetch_latest_from_pypi", _fake_fetch)
    assert vc._get_latest() == "0.5.7"
    assert vc._get_latest() == "0.5.7"
    assert calls["n"] == 1, "fetch was called more than once within the cache window"


def test_get_latest_refetches_after_ttl(monkeypatch):
    """Past CHECK_INTERVAL_S the cache should refresh."""
    calls = {"n": 0}
    monkeypatch.setattr(vc, "_fetch_latest_from_pypi", lambda: (calls.__setitem__("n", calls["n"] + 1), "0.5.7")[1])

    vc._get_latest()  # populate

    # Simulate time advancing past the TTL by manually rewriting the
    # cached timestamp; cheaper + more deterministic than freezing time.
    orig = vc._cached_latest
    assert orig is not None
    vc._cached_latest = (orig[0] - vc.CHECK_INTERVAL_S - 1, orig[1])

    vc._get_latest()
    assert calls["n"] == 2


def test_get_latest_caches_failures_too(monkeypatch):
    """A None result is also cached so we don't hammer PyPI when the
    network is blocked."""
    calls = {"n": 0}

    def _fake():
        calls["n"] += 1
        return None

    monkeypatch.setattr(vc, "_fetch_latest_from_pypi", _fake)
    assert vc._get_latest() is None
    assert vc._get_latest() is None
    assert calls["n"] == 1


# --- _read_current_version ---------------------------------------------

def test_read_current_version_from_metadata():
    """The installed package version should match what's in pyproject."""
    v = vc._read_current_version()
    assert v != "0.0.0-unknown", f"package metadata not found; got {v}"
    # Sanity-check shape: two dots minimum.
    assert v.count(".") >= 2, v


def test_read_current_version_caches(monkeypatch):
    """Reads metadata once even across many callers."""
    calls = {"n": 0}
    from importlib import metadata as _md

    def _fake(_name):
        calls["n"] += 1
        return "9.9.9"

    monkeypatch.setattr(_md, "version", _fake)
    vc._reset_cache_for_tests()
    assert vc._read_current_version() == "9.9.9"
    assert vc._read_current_version() == "9.9.9"
    assert calls["n"] == 1


# --- get_version_info (integration) ------------------------------------

def test_get_version_info_shape_with_update_available(monkeypatch, tmp_path):
    """End-to-end shape the dashboard consumes when a newer version
    exists upstream."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "uv.lock").write_text("")  # force packageManager='uv'
    monkeypatch.setattr(vc, "_fetch_latest_from_pypi", lambda: "99.0.0")

    info = vc.get_version_info()
    assert info["latest"] == "99.0.0"
    assert info["hasUpdate"] is True
    assert info["packageManager"] == "uv"
    assert info["language"] == "python"
    assert isinstance(info["current"], str) and info["current"] != ""


def test_get_version_info_no_update_when_equal(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(vc, "_read_current_version", lambda: "0.5.7")
    monkeypatch.setattr(vc, "_fetch_latest_from_pypi", lambda: "0.5.7")
    info = vc.get_version_info()
    assert info["hasUpdate"] is False
    assert info["latest"] == "0.5.7"


def test_get_version_info_hasupdate_false_when_pypi_unreachable(monkeypatch, tmp_path):
    """Network blocked → latest=None and hasUpdate=False so the banner
    silently doesn't appear (matches TS behaviour)."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(vc, "_fetch_latest_from_pypi", lambda: None)
    info = vc.get_version_info()
    assert info["latest"] is None
    assert info["hasUpdate"] is False
