"""Unit coverage for `_github_api.py` — the thin GitHub REST client +
multi-file PR creation helper.

The v0.5.10 audit flagged this module as having no direct tests. It's
exercised indirectly by `test_embedded_journey.py` (which fakes the
network), but nothing pinned the exact endpoint paths, request bodies,
or status-code mapping that GitHub's REST API expects. A bug here
silently 502s every customer's PR submit.

This file covers:
  * `github_api`: success path, non-2xx → `GitHubAPIError`, network
    failure → `GitHubAPIError` with status 0, GET vs POST/PUT body
    shapes, headers (UA, accept, auth).
  * `create_pull_request`: full happy path against `FakeGithub` (lifted
    to conftest.py); endpoint sequence (repo metadata → ref → branch →
    PUT each file → POST PR); body shape per call; bare-error
    propagation; new-file vs update flow (`sha` param presence).
  * Argument validation: blank owner/repo/changes, invalid chars.
  * Body encoding: utf-8 + multi-byte chars round-trip through base64.

Pure unit tests — no real network calls. The fake transports the same
shapes GitHub returns so `github_api` is exercised end-to-end except
for the urllib send.
"""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from unittest.mock import MagicMock

import pytest

from artanis_gravel._github_api import (
    CreatePullRequestResult,
    GitHubAPIError,
    PromptChange,
    create_pull_request,
    github_api,
)


# -------------------- github_api (low-level) --------------------


class _FakeUrlOpenResponse:
    """Stand-in for the return of urllib.request.urlopen.

    Supports the context-manager protocol and the .read()/.status
    attributes that _github_api.github_api consults."""

    def __init__(self, status: int, payload: bytes):
        self.status = status
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self) -> bytes:
        return self._payload


def _patch_urlopen(monkeypatch, response: _FakeUrlOpenResponse | Exception):
    """Replace urllib.request.urlopen with a sentinel so the unit
    test never touches the network. `response` is either a
    `_FakeUrlOpenResponse` (success) or an exception to raise."""
    captured: dict = {}

    def _fake(req, timeout=None):  # noqa: ARG001 — match urllib signature
        captured["request"] = req
        captured["timeout"] = timeout
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(urllib.request, "urlopen", _fake)
    return captured


def test_github_api_get_success_returns_decoded_json(monkeypatch):
    """A 200 with a JSON body decodes to the dict the caller sees."""
    _patch_urlopen(monkeypatch, _FakeUrlOpenResponse(200, b'{"default_branch": "main"}'))
    out = github_api("/repos/acme/app", "ghs_fake")
    assert out == {"default_branch": "main"}


def test_github_api_sends_required_headers(monkeypatch):
    """Auth, Accept, Content-Type, User-Agent are required by the
    REST API. Pin them so a stray refactor doesn't drop them."""
    captured = _patch_urlopen(
        monkeypatch, _FakeUrlOpenResponse(200, b"{}")
    )
    github_api("/repos/acme/app", "ghs_TOKEN_123")
    req = captured["request"]
    assert req.headers["Authorization"] == "Bearer ghs_TOKEN_123"
    assert req.headers["Accept"] == "application/vnd.github.v3+json"
    assert req.headers["Content-type"] == "application/json"
    assert req.headers["User-agent"] == "Gravel-SDK"


def test_github_api_get_targets_correct_host(monkeypatch):
    """Endpoint is appended to https://api.github.com — never to any
    other host. Catches a path-vs-URL refactor mistake."""
    captured = _patch_urlopen(monkeypatch, _FakeUrlOpenResponse(200, b"{}"))
    github_api("/repos/acme/app/pulls", "x")
    assert captured["request"].full_url == "https://api.github.com/repos/acme/app/pulls"


def test_github_api_post_serialises_body_to_json(monkeypatch):
    """POST/PUT bodies must be JSON-encoded bytes; GitHub rejects
    form-urlencoded for these endpoints."""
    captured = _patch_urlopen(monkeypatch, _FakeUrlOpenResponse(200, b"{}"))
    github_api(
        "/repos/acme/app/git/refs",
        "x",
        method="POST",
        body={"ref": "refs/heads/foo", "sha": "abc"},
    )
    sent = captured["request"].data
    assert sent is not None
    assert json.loads(sent.decode()) == {"ref": "refs/heads/foo", "sha": "abc"}
    assert captured["request"].get_method() == "POST"


def test_github_api_get_does_not_attach_body(monkeypatch):
    """GETs must NOT carry a body — some HTTP servers (and the
    GitHub API gateway) reject a GET with a payload."""
    captured = _patch_urlopen(monkeypatch, _FakeUrlOpenResponse(200, b"{}"))
    github_api("/repos/acme/app", "x")
    assert captured["request"].data is None


def test_github_api_empty_response_body_returns_empty_dict(monkeypatch):
    """Some endpoints (DELETE-style; 204 on PUT) return an empty body.
    Caller must get a usable dict, not a TypeError."""
    _patch_urlopen(monkeypatch, _FakeUrlOpenResponse(200, b""))
    assert github_api("/whatever", "x") == {}


def test_github_api_http_error_raises_github_api_error_with_status(monkeypatch):
    """Non-2xx → GitHubAPIError with the underlying status code so the
    caller can decide between retry vs surface."""
    err = urllib.error.HTTPError(
        url="https://api.github.com/x",
        code=404,
        msg="Not Found",
        hdrs=None,
        fp=MagicMock(read=lambda: b'{"message": "Not Found"}'),
    )
    _patch_urlopen(monkeypatch, err)
    with pytest.raises(GitHubAPIError) as ei:
        github_api("/x", "t")
    assert ei.value.status == 404
    assert "Not Found" in str(ei.value)


def test_github_api_http_error_with_non_json_body_still_raises(monkeypatch):
    """If GitHub returns HTML or empty body on error, we still raise
    GitHubAPIError — never let it silently slip through as `None`."""
    err = urllib.error.HTTPError(
        url="https://api.github.com/x",
        code=503,
        msg="Service Unavailable",
        hdrs=None,
        fp=MagicMock(read=lambda: b"<html>Down</html>"),
    )
    _patch_urlopen(monkeypatch, err)
    with pytest.raises(GitHubAPIError) as ei:
        github_api("/x", "t")
    assert ei.value.status == 503


def test_github_api_url_error_raises_with_status_zero(monkeypatch):
    """Network-layer failures (DNS, refused, timeout) → GitHubAPIError
    with status=0 so callers can branch on connectivity vs auth."""
    _patch_urlopen(monkeypatch, urllib.error.URLError("Connection refused"))
    with pytest.raises(GitHubAPIError) as ei:
        github_api("/x", "t")
    assert ei.value.status == 0
    assert "network error" in str(ei.value).lower() or "refused" in str(ei.value).lower()


def test_github_api_method_defaults_to_get(monkeypatch):
    """Spotcheck: caller can omit method= and get a GET."""
    captured = _patch_urlopen(monkeypatch, _FakeUrlOpenResponse(200, b"{}"))
    github_api("/x", "t")
    assert captured["request"].get_method() == "GET"


# -------------------- create_pull_request (high-level) --------------------


def _ok_path() -> dict[str, str]:
    """A minimal file-tree the PR creation flow can target."""
    return {"prompts/x.md": "old\n"}


def test_create_pull_request_happy_path_returns_pr_metadata(fake_github):
    """End-to-end: create_pull_request returns a CreatePullRequestResult
    populated from GitHub's PR response (html_url, number, branch)."""
    fake_github.file_contents = _ok_path()
    import artanis_gravel._github_api as gh

    # Swap github_api at module level (create_pull_request resolves
    # it via the module attribute).
    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        result = create_pull_request(
            access_token="ghs_x",
            repo_owner="acme",
            repo_name="app",
            changes=[PromptChange(path="prompts/x.md", content="new\n")],
            title="Test PR",
            description="Body",
            de_first_name="Alice",
            branch_name="gravel/draft-x",
        )
    finally:
        gh.github_api = orig
    assert isinstance(result, CreatePullRequestResult)
    assert result.pr_url == fake_github.pr_url
    assert result.pr_number == fake_github.pr_number
    assert result.branch_name == "gravel/draft-x"


def test_create_pull_request_endpoint_sequence(fake_github):
    """The PR-creation flow hits a specific endpoint order:
      1. GET /repos/{o}/{r}                (default_branch)
      2. GET /repos/{o}/{r}/git/ref/heads/{default_branch}
      3. POST /repos/{o}/{r}/git/refs       (create branch)
      4. for each change: GET + PUT /contents/{path}
      5. POST /repos/{o}/{r}/pulls          (open PR)

    Sequence is critical — getting it wrong (e.g., creating the PR
    before committing) silently opens an empty PR."""
    fake_github.file_contents = {"a.md": "1", "b.md": "2"}
    import artanis_gravel._github_api as gh

    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[
                PromptChange(path="a.md", content="new-a"),
                PromptChange(path="b.md", content="new-b"),
            ],
            title="Bulk",
            description=None,
            de_first_name=None,
            branch_name="b",
        )
    finally:
        gh.github_api = orig
    seq = [(c["method"], c["endpoint"].split("?", 1)[0]) for c in fake_github.calls]
    assert seq == [
        ("GET", "/repos/acme/app"),
        ("GET", "/repos/acme/app/git/ref/heads/main"),
        ("POST", "/repos/acme/app/git/refs"),
        ("GET", "/repos/acme/app/contents/a.md"),
        ("PUT", "/repos/acme/app/contents/a.md"),
        ("GET", "/repos/acme/app/contents/b.md"),
        ("PUT", "/repos/acme/app/contents/b.md"),
        ("POST", "/repos/acme/app/pulls"),
    ], seq


def test_create_pull_request_branch_creation_body_shape(fake_github):
    """The branch-create POST must send {ref: 'refs/heads/<name>',
    sha: <base>} — GitHub rejects any other shape with 422."""
    fake_github.file_contents = _ok_path()
    import artanis_gravel._github_api as gh

    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[PromptChange("prompts/x.md", "new")],
            title="T",
            description=None,
            de_first_name=None,
            branch_name="gravel/draft-2026-05-13",
        )
    finally:
        gh.github_api = orig
    assert len(fake_github.created_refs) == 1
    ref = fake_github.created_refs[0]
    assert ref["ref"] == "refs/heads/gravel/draft-2026-05-13"
    assert ref["sha"] == fake_github.base_sha


def test_create_pull_request_update_includes_prior_sha(fake_github):
    """An existing file on the branch must be PUT with its prior `sha`
    or GitHub rejects with 409. The flow GETs first to discover the
    sha, then PUTs."""
    fake_github.file_contents = {"prompts/x.md": "old"}
    import artanis_gravel._github_api as gh

    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[PromptChange("prompts/x.md", "new")],
            title="T",
            description=None,
            de_first_name=None,
            branch_name="b",
        )
    finally:
        gh.github_api = orig
    put = next(c for c in fake_github.calls if c["method"] == "PUT")
    assert put["body"]["sha"] == "sha-prompts/x.md"
    assert put["body"]["branch"] == "b"
    assert put["body"]["message"] == "Update prompts/x.md"


def test_create_pull_request_new_file_omits_sha(fake_github):
    """A path not yet on the branch must be PUT WITHOUT a `sha` field
    or GitHub rejects with 422. The flow lets the contents GET fail
    and falls through to the create path."""
    fake_github.file_contents = {}  # nothing exists
    import artanis_gravel._github_api as gh

    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[PromptChange("brand-new.md", "hello")],
            title="T",
            description=None,
            de_first_name=None,
            branch_name="b",
        )
    finally:
        gh.github_api = orig
    put = next(c for c in fake_github.calls if c["method"] == "PUT")
    assert "sha" not in put["body"], put["body"]


def test_create_pull_request_pr_body_credits_first_name(fake_github):
    """The PR body composer puts the DE's first name on the first
    line so the repo maintainer knows who suggested it."""
    fake_github.file_contents = _ok_path()
    import artanis_gravel._github_api as gh

    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[PromptChange("prompts/x.md", "new")],
            title="T",
            description="Body says hi",
            de_first_name="Yousef",
            branch_name="b",
        )
    finally:
        gh.github_api = orig
    pr = fake_github.opened_prs[0]
    body = pr["body"]
    assert body.splitlines()[0] == "On behalf of Yousef."
    assert "Body says hi" in body
    assert "PR created via [Gravel]" in body


def test_create_pull_request_pr_body_no_credit_when_first_name_missing(fake_github):
    """If `de_first_name` is None (anonymous flow), the body opens
    with the description, not a blank `On behalf of .` line."""
    fake_github.file_contents = _ok_path()
    import artanis_gravel._github_api as gh

    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[PromptChange("prompts/x.md", "new")],
            title="T",
            description="Just the body",
            de_first_name=None,
            branch_name="b",
        )
    finally:
        gh.github_api = orig
    body = fake_github.opened_prs[0]["body"]
    assert not body.startswith("On behalf of"), body


def test_create_pull_request_pr_body_lists_multiple_files(fake_github):
    """A multi-file PR includes a 'Files changed (N):' section so the
    reviewer sees the scope at a glance. Single-file PRs skip it."""
    fake_github.file_contents = {"a.md": "1", "b.md": "2", "c.md": "3"}
    import artanis_gravel._github_api as gh

    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[
                PromptChange("a.md", "x"),
                PromptChange("b.md", "y"),
                PromptChange("c.md", "z"),
            ],
            title="T",
            description=None,
            de_first_name="A",
            branch_name="b",
        )
    finally:
        gh.github_api = orig
    body = fake_github.opened_prs[0]["body"]
    assert "Files changed (3):" in body
    assert "`a.md`" in body and "`b.md`" in body and "`c.md`" in body


def test_create_pull_request_committed_content_is_base64_utf8(fake_github):
    """Content carrying multi-byte chars (é, 中, emoji) must round-trip
    through base64 unchanged. base64 of UTF-8 bytes, not the str."""
    fake_github.file_contents = {"x.md": "old"}
    import artanis_gravel._github_api as gh

    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[PromptChange("x.md", "café 中文 🎯")],
            title="T",
            description=None,
            de_first_name=None,
            branch_name="b",
        )
    finally:
        gh.github_api = orig
    put = next(c for c in fake_github.calls if c["method"] == "PUT")
    decoded = base64.b64decode(put["body"]["content"]).decode("utf-8")
    assert decoded == "café 中文 🎯"


def test_create_pull_request_pr_open_targets_default_branch(fake_github):
    """The PR's `base` must be the default branch (head=our branch,
    base=their default). A swap = merge conflict that opens against
    the wrong branch."""
    fake_github.default_branch = "trunk"
    fake_github.file_contents = _ok_path()
    import artanis_gravel._github_api as gh

    orig = gh.github_api
    gh.github_api = fake_github.github_api  # type: ignore[assignment]
    try:
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[PromptChange("prompts/x.md", "new")],
            title="T",
            description=None,
            de_first_name=None,
            branch_name="b",
        )
    finally:
        gh.github_api = orig
    pr = fake_github.opened_prs[0]
    assert pr["base"] == "trunk"
    assert pr["head"] == "b"
    assert pr["title"] == "T"


def test_create_pull_request_rejects_invalid_repo_owner():
    """Reject shell-meta or path chars in owner/repo before we send
    anything to GitHub — prevents URL-injection through the path."""
    with pytest.raises(ValueError):
        create_pull_request(
            access_token="t",
            repo_owner="acme/../etc",
            repo_name="app",
            changes=[PromptChange("a.md", "x")],
            title="T",
            description=None,
            de_first_name=None,
            branch_name="b",
        )


def test_create_pull_request_rejects_invalid_repo_name():
    with pytest.raises(ValueError):
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="bad name with spaces",
            changes=[PromptChange("a.md", "x")],
            title="T",
            description=None,
            de_first_name=None,
            branch_name="b",
        )


def test_create_pull_request_rejects_empty_changes():
    with pytest.raises(ValueError):
        create_pull_request(
            access_token="t",
            repo_owner="acme",
            repo_name="app",
            changes=[],
            title="T",
            description=None,
            de_first_name=None,
            branch_name="b",
        )


def test_create_pull_request_propagates_github_api_error(fake_github):
    """A failure in the middle of the flow (e.g., 422 on branch
    create because the branch already exists) must propagate as
    GitHubAPIError, not be silently swallowed."""
    fake_github.file_contents = _ok_path()
    import artanis_gravel._github_api as gh

    orig = gh.github_api

    def _raise_on_refs(endpoint, token, *, method="GET", body=None):
        if method == "POST" and endpoint.endswith("/git/refs"):
            raise GitHubAPIError("Reference already exists", 422)
        return orig(endpoint, token, method=method, body=body)

    gh.github_api = lambda *a, **kw: _raise_on_refs(*a, **kw) if (kw.get("method") == "POST" and a[0].endswith("/git/refs")) else fake_github.github_api(*a, **kw)  # type: ignore[assignment]
    try:
        with pytest.raises(GitHubAPIError) as ei:
            create_pull_request(
                access_token="t",
                repo_owner="acme",
                repo_name="app",
                changes=[PromptChange("prompts/x.md", "new")],
                title="T",
                description=None,
                de_first_name=None,
                branch_name="b",
            )
        assert ei.value.status == 422
    finally:
        gh.github_api = orig
