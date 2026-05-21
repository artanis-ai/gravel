"""Pytest config for the gravel SDK tests."""
from __future__ import annotations

import base64
import json
import os

import pytest


@pytest.fixture(autouse=True)
def _clean_gravel_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip ambient GRAVEL_* vars so tests get deterministic env handling.

    Tests that need credentials set them explicitly via monkeypatch.setenv.
    Integration tests bypass this by reading os.environ before the patch
    inside their skipif guard.
    """
    for key in list(os.environ):
        if key.startswith("GRAVEL_"):
            monkeypatch.delenv(key, raising=False)


class FakeGithub:
    """Stand-in for the network surface used by `_prompts_submit` +
    `_github_api`. Records every endpoint hit, every commit body it
    would PUT, and every PR it would open, so tests can introspect
    without touching api.github.com.

    Construct with a mapping of repo-relative path → utf-8 file
    content; the `contents/<path>` GET path returns the matching
    file. Other GET endpoints (repo metadata, refs) are handled by
    `default_responses` you can override per-test.

    Lifted from tests/test_embedded_journey.py (v0.5.10) and shared
    here so test_github_api.py + future PR-flow tests can reuse the
    same stub semantics without copy-paste.
    """

    def __init__(
        self,
        file_contents: dict[str, str] | None = None,
        *,
        default_branch: str = "main",
        base_sha: str = "base-sha-000",
        pr_number: int = 42,
        pr_url: str = "https://github.com/acme/app/pull/42",
        existing_open_pr: dict | None = None,
    ):
        self.file_contents = dict(file_contents or {})
        self.default_branch = default_branch
        self.base_sha = base_sha
        self.pr_number = pr_number
        self.pr_url = pr_url
        # Seed an open gravel PR when the test wants to exercise the
        # amendment path. Pass `existing_open_pr={"head":{"ref":
        # "gravel/draft"}, "html_url": "...", "number": 7}` to make
        # `find_open_gravel_pr` return it.
        self.existing_open_pr = existing_open_pr
        # Capture per call type so tests can pin shapes.
        self.calls: list[dict] = []  # {endpoint, method, body}
        self.put_changes: list[tuple[str, str]] = []  # (path, content)
        self.created_refs: list[dict] = []
        self.deleted_refs: list[str] = []
        self.opened_prs: list[dict] = []

    def github_api(self, endpoint: str, access_token: str, *, method: str = "GET", body=None):
        """Drop-in for `_github_api.github_api`."""
        self.calls.append({"endpoint": endpoint, "method": method, "body": body})

        # GET /repos/{o}/{r}/pulls?state=open... — used by
        # find_open_gravel_pr to decide between fresh-PR and
        # amendment paths.
        if method == "GET" and "/pulls?" in endpoint:
            return [self.existing_open_pr] if self.existing_open_pr else []

        # DELETE /repos/{o}/{r}/git/refs/heads/{branch} — fresh-PR
        # path uses this to clear stale branches left over from
        # closed/merged PRs.
        if method == "DELETE" and "/git/refs/heads/" in endpoint:
            branch = endpoint.split("/git/refs/heads/", 1)[1]
            self.deleted_refs.append(branch)
            return {}

        # GET /repos/{o}/{r}
        if method == "GET" and endpoint.startswith("/repos/") and "/git/" not in endpoint and "/contents/" not in endpoint and "/pulls" not in endpoint:
            return {"default_branch": self.default_branch}

        # GET /repos/{o}/{r}/git/ref/heads/{branch}
        if method == "GET" and "/git/ref/heads/" in endpoint:
            return {"object": {"sha": self.base_sha}}

        # GET /repos/{o}/{r}/contents/<path>?ref=...
        if method == "GET" and "/contents/" in endpoint:
            ep = endpoint.split("?", 1)[0]
            path = ep.split("/contents/", 1)[1]
            content = self.file_contents.get(path)
            if content is None:
                from artanis_gravel._github_api import GitHubAPIError

                raise GitHubAPIError("not found", 404)
            return {
                "content": base64.b64encode(content.encode()).decode(),
                "encoding": "base64",
                "sha": f"sha-{path}",
            }

        # POST /repos/{o}/{r}/git/refs
        if method == "POST" and endpoint.endswith("/git/refs"):
            self.created_refs.append(body or {})
            return {}

        # PUT /repos/{o}/{r}/contents/<path>
        if method == "PUT" and "/contents/" in endpoint:
            path = endpoint.split("/contents/", 1)[1]
            assert body is not None
            decoded = base64.b64decode(body["content"]).decode("utf-8")
            self.put_changes.append((path, decoded))
            self.file_contents[path] = decoded
            return {"content": {"sha": f"sha-after-{path}"}}

        # POST /repos/{o}/{r}/pulls
        if method == "POST" and endpoint.endswith("/pulls"):
            self.opened_prs.append(body or {})
            return {"html_url": self.pr_url, "number": self.pr_number}

        return {}

    def create_pr(self, **kwargs):
        """Drop-in for `_github_api.create_pull_request`. Used by
        prompts-submit tests that bypass the multi-call flow."""
        for change in kwargs["changes"]:
            self.put_changes.append((change.path, change.content))
        from artanis_gravel._github_api import CreatePullRequestResult

        is_amendment = self.existing_open_pr is not None
        if is_amendment:
            pr_url = self.existing_open_pr.get("html_url", self.pr_url)
            pr_number = self.existing_open_pr.get("number", self.pr_number)
        else:
            self.opened_prs.append(
                {
                    "title": kwargs["title"],
                    "head": kwargs.get("branch_name"),
                    "body": kwargs.get("description"),
                }
            )
            pr_url = self.pr_url
            pr_number = self.pr_number
        return CreatePullRequestResult(
            pr_url=pr_url,
            pr_number=pr_number,
            branch_name=kwargs.get("branch_name", "gravel/draft"),
            is_amendment=is_amendment,
        )

    def assert_committed(self, path: str, expected_content: str) -> None:
        """Assert that exactly one commit for `path` matched
        `expected_content`. Concise per-test failure messages."""
        matches = [c for p, c in self.put_changes if p == path]
        assert matches, f"no commit for {path!r}; committed paths: {[p for p, _ in self.put_changes]}"
        assert any(c == expected_content for c in matches), (
            f"none of the commits for {path!r} matched expected content\n"
            f"expected:\n{expected_content!r}\nactual:\n{matches!r}"
        )


@pytest.fixture
def fake_github() -> FakeGithub:
    """Per-test FakeGithub instance with no pre-loaded files."""
    return FakeGithub()


@pytest.fixture
def patch_submit_github(monkeypatch: pytest.MonkeyPatch):
    """Returns a callable that wires a `FakeGithub` into the
    `_prompts_submit` module's network surface for the duration of
    the test. Use when you need the full `submit_drafts` pipeline
    without hitting the network."""

    def _wire(fake: FakeGithub) -> None:
        import artanis_gravel._prompts_submit as ps

        monkeypatch.setattr(ps, "github_api", fake.github_api)
        monkeypatch.setattr(ps, "create_pull_request", fake.create_pr)
        # Branch-aware manifest fetch (v0.9.5): _prompts_submit imports
        # find_open_gravel_pr directly. Patch it to honour the fake's
        # `existing_open_pr` slot.
        monkeypatch.setattr(
            ps,
            "find_open_gravel_pr",
            lambda *, access_token, repo_owner, repo_name: fake.existing_open_pr,
        )

    return _wire


# Suppress unused-import warning for `json` (callers reach for it
# transitively via base64 patterns; kept here for editor completion).
_ = json
