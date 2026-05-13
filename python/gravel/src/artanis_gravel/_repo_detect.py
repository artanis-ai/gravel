"""Best-effort detection of the GitHub repo this SDK is running in.

Port of `packages/sdk-ts/src/github/repo-detect.ts`. Used to send
`expected_repo=owner/name` to the CP's install/start endpoint so
multi-repo installs land the right repo in the SDK's .env.local.

Falls back to None when: not in a git work tree, no `origin` remote,
remote isn't on github.com, or URL is unparseable.
"""
from __future__ import annotations

import re
import subprocess


# Same three URL shapes the TS helper accepts. Keep them in sync.
_SSH_RE = re.compile(r"^git@github\.com:([^/\s]+)/([^/\s]+?)(?:\.git)?$", re.IGNORECASE)
_HTTPS_RE = re.compile(
    r"^https?://(?:[^@]+@)?github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$",
    re.IGNORECASE,
)
_PROTO_RE = re.compile(
    r"^(?:ssh|git)(?:\+ssh)?://(?:[^@]+@)?github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$",
    re.IGNORECASE,
)


def parse_github_remote_url(url: str) -> tuple[str, str] | None:
    """Parse a GitHub remote URL into (owner, name). Returns None when
    the URL isn't a recognised GitHub form."""
    trimmed = url.strip()
    if not trimmed:
        return None
    for regex in (_SSH_RE, _HTTPS_RE, _PROTO_RE):
        m = regex.match(trimmed)
        if m:
            return m.group(1), m.group(2)
    return None


def detect_local_github_repo(cwd: str | None = None) -> tuple[str, str] | None:
    """Detect the local GitHub owner/name via `git remote get-url origin`.

    Returns None on any failure (no git binary, not a repo, no origin,
    non-github URL). 2-second timeout so a hanging git invocation
    doesn't block install handoff."""
    try:
        proc = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    return parse_github_remote_url(proc.stdout)
