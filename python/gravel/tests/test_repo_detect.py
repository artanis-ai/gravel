"""Tests for the GitHub remote URL parser. The TS counterpart lives at
packages/sdk-ts/tests/repo-detect.test.ts — keep both lists in sync."""
from __future__ import annotations

import pytest

from artanis_gravel._repo_detect import parse_github_remote_url


@pytest.mark.parametrize(
    "url,expected",
    [
        # SSH
        ("git@github.com:artanis-ai/gravel.git", ("artanis-ai", "gravel")),
        ("git@github.com:artanis-ai/gravel", ("artanis-ai", "gravel")),
        # HTTPS variations
        ("https://github.com/artanis-ai/gravel.git", ("artanis-ai", "gravel")),
        ("https://github.com/artanis-ai/gravel", ("artanis-ai", "gravel")),
        ("https://github.com/artanis-ai/gravel/", ("artanis-ai", "gravel")),
        (
            "https://oauth2:token@github.com/artanis-ai/gravel.git",
            ("artanis-ai", "gravel"),
        ),
        ("http://github.com/artanis-ai/gravel.git", ("artanis-ai", "gravel")),
        # ssh:// and git:// schemes
        ("ssh://git@github.com/artanis-ai/gravel.git", ("artanis-ai", "gravel")),
        ("git://github.com/artanis-ai/gravel.git", ("artanis-ai", "gravel")),
        # Case-insensitive
        ("HTTPS://GITHUB.COM/artanis-ai/gravel.git", ("artanis-ai", "gravel")),
        # Punctuation in repo names
        (
            "git@github.com:my-org/my.weird_repo-name.git",
            ("my-org", "my.weird_repo-name"),
        ),
        # Non-github → None
        ("git@gitlab.com:foo/bar.git", None),
        ("https://bitbucket.org/foo/bar.git", None),
        # Malformed → None
        ("", None),
        ("not a url", None),
        ("https://github.com/onlyone", None),
        ("https://github.com//bar.git", None),
    ],
)
def test_parse_github_remote_url(url: str, expected: tuple[str, str] | None) -> None:
    assert parse_github_remote_url(url) == expected
