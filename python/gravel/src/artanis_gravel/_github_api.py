"""Thin GitHub REST client + multi-file PR creation.

Port of `packages/sdk-ts/src/github/api.ts` + `create-pr.ts`. Used by
the /api/prompts/submit handler to turn a DE's accumulated drafts into
a single PR via the installation token minted by the CP.

Kept stdlib-only (urllib) so the SDK doesn't grow a `requests` or
`httpx` dependency for a feature that's invoked at most once per PR
submission. Network timeouts are explicit (10 s per call).
"""
from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


class GitHubAPIError(RuntimeError):
    """Raised when the GitHub API returns a non-2xx. `.status` is the
    HTTP status code; the message is GitHub's `message` body field, or
    a generic string when the body wasn't JSON."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


def github_api(
    endpoint: str,
    access_token: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> Any:
    """Issue a single GitHub REST call. Returns the decoded JSON body.

    Designed for the PR-creation flow only — anything more elaborate
    should reach for PyGithub. Matches the TS helper's accept/UA
    headers byte-for-byte so server-side rate-limit accounting agrees."""
    url = "https://api.github.com" + endpoint
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Gravel-SDK",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = resp.read()
            if not payload:
                return {}
            return json.loads(payload.decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read() if e.fp else b""
        msg = ""
        # GitHub returns JSON on most errors but sends HTML on
        # cloudflare / WAF blocks. Narrowing the catch to decode/parse
        # errors means a stray non-decode bug here would propagate
        # cleanly instead of being swallowed as "no message".
        try:
            parsed = json.loads(raw.decode("utf-8"))
            if isinstance(parsed, dict):
                msg = str(parsed.get("message") or "")
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        raise GitHubAPIError(msg or f"GitHub API error: {e.code}", e.code) from e
    except urllib.error.URLError as e:
        raise GitHubAPIError(f"GitHub API network error: {e.reason}", 0) from e


# -------------------- Multi-file PR creation --------------------


@dataclass
class PromptChange:
    """A single file's new content to commit. Path is repo-relative,
    forward-slashes, no leading `./`."""
    path: str
    content: str


@dataclass
class CreatePullRequestResult:
    pr_url: str
    pr_number: int
    branch_name: str
    # True when the call landed on an already-open PR (commits added
    # to the existing branch, no new PR opened). False when a fresh
    # PR was created. Surfaced to the dashboard so the success copy
    # can read "added to your existing pull request" instead of
    # "opened a new pull request". See UX 8 in STATUS.md.
    is_amendment: bool = False


_REPO_RE = re.compile(r"^[\w.-]+$")


def _base64_utf8(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


def find_open_gravel_pr(
    *,
    access_token: str,
    repo_owner: str,
    repo_name: str,
) -> dict[str, Any] | None:
    """Return the open PR raised by Gravel for this repo, if any.

    Matches by `head.ref == "gravel/draft"` (the canonical stable
    branch — see `_prompts_submit.draft_branch_for`). One open PR per
    project at a time is the v0.9.x model: subsequent submissions
    push commits to the existing branch and the open PR auto-updates.
    Returns None when no Gravel PR is open (next submit opens a fresh
    one).
    """
    pulls = github_api(
        f"/repos/{repo_owner}/{repo_name}/pulls?state=open&per_page=100",
        access_token,
    )
    if not isinstance(pulls, list):
        return None
    for pr in pulls:
        if not isinstance(pr, dict):
            continue
        head = pr.get("head")
        if not isinstance(head, dict):
            continue
        ref = head.get("ref")
        if isinstance(ref, str) and ref == "gravel/draft":
            return pr
    return None


def create_pull_request(
    *,
    access_token: str,
    repo_owner: str,
    repo_name: str,
    changes: list[PromptChange],
    title: str,
    description: str | None,
    de_first_name: str | None,
    branch_name: str,
    manifest_diff: list[Any] | None = None,
) -> CreatePullRequestResult:
    """Open or amend a PR with `changes` against the repo's default
    branch.

    Two paths, single entry point so callers don't have to know which
    branch they're hitting:

    1. Amendment path (an open Gravel PR exists): skip branch + PR
       create, PUT each file on top of the existing `gravel/draft`
       branch (the open PR auto-updates), return `is_amendment=True`
       with the existing PR's url + number.

    2. Fresh path (no open Gravel PR): if a stale `gravel/draft`
       branch lingers from a closed/merged PR, delete it. Then create
       the branch off the default branch, PUT each file, POST a new
       PR, return `is_amendment=False`.

    Mirrors `packages/sdk-ts/src/github/create-pr.ts:createPullRequest`.
    """
    if not repo_owner or not repo_name or not changes:
        raise ValueError("repo_owner, repo_name, and at least one change are required")
    if not _REPO_RE.fullmatch(repo_owner) or not _REPO_RE.fullmatch(repo_name):
        raise ValueError("Invalid repo owner or name")

    # Try the amendment path first.
    existing_pr = find_open_gravel_pr(
        access_token=access_token, repo_owner=repo_owner, repo_name=repo_name
    )
    if existing_pr is not None:
        existing_branch = existing_pr["head"]["ref"]
        _put_files_on_branch(
            access_token=access_token,
            repo_owner=repo_owner,
            repo_name=repo_name,
            changes=changes,
            branch_name=existing_branch,
        )
        html_url = existing_pr.get("html_url")
        number = existing_pr.get("number")
        if not isinstance(html_url, str) or not isinstance(number, int):
            raise GitHubAPIError("open PR returned an unexpected shape", 0)
        return CreatePullRequestResult(
            pr_url=html_url,
            pr_number=number,
            branch_name=existing_branch,
            is_amendment=True,
        )

    # Fresh-PR path. Tear down a stale branch (closed/merged PR) first
    # so the POST /git/refs below doesn't 422.
    try:
        github_api(
            f"/repos/{repo_owner}/{repo_name}/git/refs/heads/{branch_name}",
            access_token,
            method="DELETE",
        )
    except GitHubAPIError:
        # Branch didn't exist (the common case for fresh installs).
        pass

    repo = github_api(f"/repos/{repo_owner}/{repo_name}", access_token)
    default_branch = repo.get("default_branch")
    if not isinstance(default_branch, str):
        raise GitHubAPIError("repo response missing default_branch", 0)
    ref = github_api(
        f"/repos/{repo_owner}/{repo_name}/git/ref/heads/{default_branch}",
        access_token,
    )
    base_sha = ref.get("object", {}).get("sha")
    if not isinstance(base_sha, str):
        raise GitHubAPIError("default-branch ref missing object.sha", 0)

    github_api(
        f"/repos/{repo_owner}/{repo_name}/git/refs",
        access_token,
        method="POST",
        body={"ref": f"refs/heads/{branch_name}", "sha": base_sha},
    )

    _put_files_on_branch(
        access_token=access_token,
        repo_owner=repo_owner,
        repo_name=repo_name,
        changes=changes,
        branch_name=branch_name,
    )

    # Import here to dodge the cycle (`_pr_body` references the
    # PromptChange dataclass defined in this module).
    from ._pr_body import compose_pr_body

    pr = github_api(
        f"/repos/{repo_owner}/{repo_name}/pulls",
        access_token,
        method="POST",
        body={
            "title": title,
            "head": branch_name,
            "base": default_branch,
            "body": compose_pr_body(
                description=description,
                de_first_name=de_first_name,
                changes=changes,
                manifest_diff=manifest_diff,
                repo_owner=repo_owner,
                repo_name=repo_name,
                branch_name=branch_name,
            ),
        },
    )
    html_url = pr.get("html_url")
    number = pr.get("number")
    if not isinstance(html_url, str) or not isinstance(number, int):
        raise GitHubAPIError("PR creation returned an unexpected body shape", 0)
    return CreatePullRequestResult(
        pr_url=html_url,
        pr_number=number,
        branch_name=branch_name,
        is_amendment=False,
    )


def _put_files_on_branch(
    *,
    access_token: str,
    repo_owner: str,
    repo_name: str,
    changes: list[PromptChange],
    branch_name: str,
) -> None:
    """PUT each change as a file on `branch_name`. Used by both the
    fresh-PR and amendment paths."""
    for change in changes:
        file_sha: str | None = None
        try:
            existing = github_api(
                f"/repos/{repo_owner}/{repo_name}/contents/{change.path}?ref={branch_name}",
                access_token,
            )
            sha = existing.get("sha") if isinstance(existing, dict) else None
            if isinstance(sha, str):
                file_sha = sha
        except GitHubAPIError:
            # File doesn't exist on the branch yet — create.
            pass

        put_body: dict[str, Any] = {
            "message": f"Update {change.path}",
            "content": _base64_utf8(change.content),
            "branch": branch_name,
        }
        if file_sha:
            put_body["sha"] = file_sha
        github_api(
            f"/repos/{repo_owner}/{repo_name}/contents/{change.path}",
            access_token,
            method="PUT",
            body=put_body,
        )
