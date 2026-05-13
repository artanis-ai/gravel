"""Local helper to ask git "is this file on the upstream branch yet?".

Used by the dashboard's /api/prompts list to badge unpushed prompts
and by /api/prompts/submit to fail fast (with a clear `prompt_not_pushed`
code) rather than letting the GitHub API return a generic 404.

Strategy:
    1. Resolve the upstream of the current branch (`git rev-parse @{u}`).
       Falls back to `origin/main`, then `origin/master`.
    2. Run a single `git ls-tree --name-only <upstream> -- <paths…>`.
       Anything in `paths` that didn't echo back is unpushed.

Returns an empty set on any failure (no git, not a repo, no upstream,
no remote). The dashboard treats "unknown" the same as "pushed" — the
submit endpoint will still try, and GitHub's actual response is the
ground truth.
"""
from __future__ import annotations

import subprocess


def _git(args: list[str], cwd: str) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return 1, ""
    return proc.returncode, proc.stdout


def _resolve_upstream(repo_root: str) -> str | None:
    rc, out = _git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repo_root)
    if rc == 0:
        ref = out.strip()
        if ref:
            return ref
    for fallback in ("origin/main", "origin/master"):
        rc, _ = _git(["rev-parse", "--verify", fallback], repo_root)
        if rc == 0:
            return fallback
    return None


def unpushed_paths(repo_root: str, paths: list[str]) -> set[str]:
    """Return the subset of `paths` that are NOT on the upstream branch.

    Quiet on failure — see module docstring for rationale.
    """
    if not paths:
        return set()
    upstream = _resolve_upstream(repo_root)
    if not upstream:
        return set()
    # `git ls-tree --name-only <ref> -- <paths…>` echoes back any path
    # that exists at that ref. We can pass all paths in one call.
    rc, out = _git(
        ["ls-tree", "--name-only", upstream, "--", *paths],
        repo_root,
    )
    if rc != 0:
        return set()
    present = {line.strip() for line in out.splitlines() if line.strip()}
    return {p for p in paths if p not in present}
