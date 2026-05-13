"""End-to-end coverage for the embedded-prompt journey.

What this file pins:

  1. **Char-offset slicing is correct.** For an embedded prompt with
     a charStart/charEnd that's offset-from-line-start (not the whole
     line), `GET /api/prompts/:id` must return EXACTLY the substring.
     Off-by-one bugs here ship a wrong prompt body to the dashboard
     editor, the user "fixes" something that isn't broken, and the
     PR replaces the wrong characters in the source file.

  2. **All five stacks return the same bytes.** FastAPI, raw ASGI,
     raw WSGI, Django, Flask. Bug class: a stack-specific adapter
     drops or duplicates bytes (header double-encoding, body chunked
     differently, etc). We hit the same endpoint through each adapter
     against the same source fixture and assert the responses match
     byte-for-byte.

  3. **PR flow rewrites the manifest correctly when text length
     changes.** Drafts that ADD lines push later same-file embedded
     prompts down; drafts that REMOVE lines pull them up. The
     manifest written into the PR must reflect that, otherwise a
     merged repo's `.gravel/manifest.json` points at the wrong byte
     ranges and the next dashboard request returns the wrong slice.
"""
from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from typing import Any

import pytest


# -------------------- Fixture: a source file with three embedded prompts --------------------

# Three triple-quoted prompts inside a single Python module. We pick
# char ranges by hand so the test fails noisily if anyone shifts the
# fixture text without recomputing offsets.
SOURCE = (
    "# Module-level intro\n"               # 21 chars
    "\n"                                    # 22
    "SYSTEM = '''\n"                        # 35
    "You are careful.\n"                    # 52
    "Be concise.\n"                         # 64
    "'''\n"                                 # 68
    "\n"                                    # 69
    "USER = '''\n"                          # 80
    "Summarise the document.\n"             # 104
    "'''\n"                                 # 108
    "\n"                                    # 109
    "ASSISTANT = '''\n"                     # 125
    "OK.\n"                                 # 129
    "'''\n"                                 # 133
)

# Char ranges (inclusive-start, exclusive-end) for the body of each
# triple-quoted block. Computed against SOURCE; asserted below so a
# fixture edit doesn't silently break the test.
SYSTEM_START, SYSTEM_END = 35, 64        # "You are careful.\nBe concise.\n"
USER_START, USER_END = 80, 104           # "Summarise the document.\n"
ASSISTANT_START, ASSISTANT_END = 125, 129  # "OK.\n"


def test_fixture_offsets_match_source():
    """If you edit SOURCE, this test fails first and tells you which
    range to recompute. Cheaper than chasing a slice bug elsewhere."""
    assert SOURCE[SYSTEM_START:SYSTEM_END] == "You are careful.\nBe concise.\n"
    assert SOURCE[USER_START:USER_END] == "Summarise the document.\n"
    assert SOURCE[ASSISTANT_START:ASSISTANT_END] == "OK.\n"


def _manifest_for(repo_root: Path) -> dict:
    """Build a manifest pointing at the three embedded prompts in
    `prompts.py` under `repo_root`. The wizard would normally write
    this; here we hand-construct so the offsets are pinned."""
    (repo_root / "prompts.py").write_text(SOURCE, encoding="utf-8")
    return {
        "version": 1,
        "lastFullScanAt": "2026-05-13T12:00:00Z",
        "prompts": [
            {
                "id": "p_system",
                "type": "embedded",
                "path": "prompts.py",
                "lineStart": 4,
                "lineEnd": 5,
                "charStart": SYSTEM_START,
                "charEnd": SYSTEM_END,
                "varName": "SYSTEM",
                "hash": "sha256:1",
            },
            {
                "id": "p_user",
                "type": "embedded",
                "path": "prompts.py",
                "lineStart": 9,
                "lineEnd": 9,
                "charStart": USER_START,
                "charEnd": USER_END,
                "varName": "USER",
                "hash": "sha256:2",
            },
            {
                "id": "p_assistant",
                "type": "embedded",
                "path": "prompts.py",
                "lineStart": 13,
                "lineEnd": 13,
                "charStart": ASSISTANT_START,
                "charEnd": ASSISTANT_END,
                "varName": "ASSISTANT",
                "hash": "sha256:3",
            },
        ],
    }


def _write_manifest_and_chdir(monkeypatch, tmp_path: Path) -> Path:
    """Stand up a fake repo at tmp_path with a manifest + source,
    chdir there, and return the path. Centralises the boilerplate so
    each stack-specific test stays focused on its adapter."""
    manifest = _manifest_for(tmp_path)
    (tmp_path / ".gravel").mkdir()
    (tmp_path / ".gravel" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    return tmp_path


# -------------------- Per-stack request helpers --------------------
#
# Each `_request_*` function takes a path + cookies and returns
# (status, body_bytes). The cross-stack equality test calls each one
# with the same prompt id and asserts the bodies match.


def _fastapi_request(path: str, cookie: str) -> tuple[int, bytes]:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from artanis_gravel import GravelConfig
    from artanis_gravel.fastapi import create_gravel_router

    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""},
        auth={"default_password": "test-pw"},
        mount_path="/admin/ai",
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    client = TestClient(app)
    res = client.get(path, headers={"cookie": cookie})
    return res.status_code, res.content


def _login_fastapi() -> str:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from artanis_gravel import GravelConfig
    from artanis_gravel.fastapi import create_gravel_router

    app = FastAPI()
    cfg = GravelConfig(
        database={"url": ""},
        auth={"default_password": "test-pw"},
        mount_path="/admin/ai",
    )
    app.include_router(create_gravel_router(cfg), prefix="/admin/ai")
    client = TestClient(app)
    res = client.post("/admin/ai/api/auth/login", json={"password": "test-pw"})
    assert res.status_code == 200, res.text
    return res.headers["set-cookie"].split(";", 1)[0]


def _asgi_request(path: str, cookie: str) -> tuple[int, bytes]:
    """Drive GravelAsgiApp directly without an HTTP server."""
    import asyncio

    from artanis_gravel import GravelConfig
    from artanis_gravel.asgi import GravelAsgiApp

    cfg = GravelConfig(
        database={"url": ""},
        auth={"default_password": "test-pw"},
        mount_path="/admin/ai",
    )
    app = GravelAsgiApp(cfg)

    # Strip /admin/ai prefix; the GravelAsgiApp expects scope.path to
    # be relative when root_path is set.
    sub = path[len("/admin/ai") :] if path.startswith("/admin/ai") else path
    scope = {
        "type": "http",
        "method": "GET",
        "path": sub or "/",
        "root_path": "",
        "query_string": b"",
        "scheme": "http",
        "headers": [(b"host", b"testserver"), (b"cookie", cookie.encode())],
    }
    sent: list[dict] = []

    async def _receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def _send(msg):
        sent.append(msg)

    asyncio.new_event_loop().run_until_complete(app(scope, _receive, _send))
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = next(m for m in sent if m["type"] == "http.response.body")
    return start["status"], body["body"]


def _wsgi_request(path: str, cookie: str) -> tuple[int, bytes]:
    """Drive gravel_wsgi_app directly."""
    from artanis_gravel import GravelConfig
    from artanis_gravel.asgi import gravel_wsgi_app

    cfg = GravelConfig(
        database={"url": ""},
        auth={"default_password": "test-pw"},
        mount_path="/admin/ai",
    )
    app = gravel_wsgi_app(cfg)
    sub = path[len("/admin/ai") :] if path.startswith("/admin/ai") else path
    environ = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": sub or "/",
        "QUERY_STRING": "",
        "HTTP_HOST": "testserver",
        "HTTP_COOKIE": cookie,
        "wsgi.url_scheme": "http",
        "wsgi.input": BytesIO(b""),
    }
    captured: dict[str, Any] = {}

    def _start(status: str, headers: list[tuple[str, str]]) -> None:
        captured["status"] = int(status.split(" ", 1)[0])
        captured["headers"] = headers

    body = b"".join(app(environ, _start))
    return captured["status"], body


def _django_request(path: str, cookie: str) -> tuple[int, bytes]:
    """Drive the Django integration via Django's test Client."""
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=False,
            ALLOWED_HOSTS=["*"],
            SECRET_KEY="test-key",
            DATABASES={},
            INSTALLED_APPS=[],
            ROOT_URLCONF=__name__,
            MIDDLEWARE=[],
        )
        import django

        django.setup()

    from django.test import Client
    from django.urls import clear_url_caches, include, path as dj_path

    from artanis_gravel import GravelConfig
    from artanis_gravel.django import gravel_urls

    cfg = GravelConfig(
        database={"url": ""},
        auth={"default_password": "test-pw"},
        mount_path="/admin/ai",
    )
    global urlpatterns
    urlpatterns = [dj_path("admin/ai/", include(gravel_urls(cfg)))]
    clear_url_caches()
    client = Client()
    res = client.get(path, HTTP_COOKIE=cookie)
    return res.status_code, bytes(res.content)


def _flask_request(path: str, cookie: str) -> tuple[int, bytes]:
    """Drive the Flask integration via Flask's test client."""
    flask = pytest.importorskip("flask")
    pytest.importorskip("a2wsgi")
    from artanis_gravel import GravelConfig
    from artanis_gravel.flask import mount_on_flask

    app = flask.Flask(__name__)
    cfg = GravelConfig(
        database={"url": ""},
        auth={"default_password": "test-pw"},
        mount_path="/admin/ai",
    )
    mount_on_flask(app, cfg)
    client = app.test_client()
    res = client.get(path, headers={"Cookie": cookie})
    return res.status_code, res.data


# Used by `_django_request` as ROOT_URLCONF; rebound per-test.
urlpatterns: list = []


# -------------------- Test 1: char-offset slicing is correct --------------------


def test_embedded_slice_returns_exact_chars_via_fastapi(monkeypatch, tmp_path):
    """The headline correctness check: ask for p_system, get back EXACTLY
    SOURCE[SYSTEM_START:SYSTEM_END]. No leading/trailing whitespace
    drift, no off-by-one, no newline normalisation."""
    _write_manifest_and_chdir(monkeypatch, tmp_path)
    cookie = _login_fastapi()
    status, body = _fastapi_request("/admin/ai/api/prompts/p_system", cookie)
    assert status == 200, body
    data = json.loads(body)
    assert data["id"] == "p_system"
    assert data["varName"] == "SYSTEM"
    assert data["content"] == SOURCE[SYSTEM_START:SYSTEM_END]


@pytest.mark.parametrize(
    "prompt_id,start,end,var_name",
    [
        ("p_system", SYSTEM_START, SYSTEM_END, "SYSTEM"),
        ("p_user", USER_START, USER_END, "USER"),
        ("p_assistant", ASSISTANT_START, ASSISTANT_END, "ASSISTANT"),
    ],
)
def test_embedded_slice_each_prompt(monkeypatch, tmp_path, prompt_id, start, end, var_name):
    """All three prompts in the fixture, one at a time. Confirms the
    handler isn't accidentally pinned to the first/last manifest entry."""
    _write_manifest_and_chdir(monkeypatch, tmp_path)
    cookie = _login_fastapi()
    status, body = _fastapi_request(f"/admin/ai/api/prompts/{prompt_id}", cookie)
    assert status == 200, body
    data = json.loads(body)
    assert data["content"] == SOURCE[start:end]
    assert data["varName"] == var_name


# -------------------- Test 2: cross-stack byte-equality --------------------


def test_embedded_slice_same_across_all_stacks(monkeypatch, tmp_path):
    """FastAPI, ASGI, WSGI, Django, Flask — same prompt id, same source,
    same byte response. If a stack's adapter mangles the body (truncates,
    re-encodes, header drift), this test surfaces it instantly."""
    _write_manifest_and_chdir(monkeypatch, tmp_path)
    cookie = _login_fastapi()
    expected_content = SOURCE[SYSTEM_START:SYSTEM_END]

    responses: dict[str, tuple[int, bytes]] = {}
    responses["fastapi"] = _fastapi_request("/admin/ai/api/prompts/p_system", cookie)
    responses["asgi"] = _asgi_request("/admin/ai/api/prompts/p_system", cookie)
    responses["wsgi"] = _wsgi_request("/admin/ai/api/prompts/p_system", cookie)
    responses["django"] = _django_request("/admin/ai/api/prompts/p_system", cookie)
    responses["flask"] = _flask_request("/admin/ai/api/prompts/p_system", cookie)

    for stack, (status, body) in responses.items():
        assert status == 200, (stack, body)
        # Each stack might emit JSON with different whitespace, so
        # compare the decoded `content` field rather than raw bytes.
        data = json.loads(body)
        assert data["content"] == expected_content, (stack, data)
        assert data["id"] == "p_system", (stack, data)
        assert data["varName"] == "SYSTEM", (stack, data)


# -------------------- Test 3: manifest rewrite on PR submit --------------------


def _mk_resolved_args(repo_root: Path, drafts: list, repo_owner: str = "acme", repo_name: str = "app"):
    """Build a SubmitArgs against a tmpdir repo. Used by the rewrite
    tests so they don't have to repeat the boilerplate."""
    from artanis_gravel._prompts_submit import SubmitArgs

    return SubmitArgs(
        repo_root=repo_root,
        drafts=drafts,
        draft_branch="gravel/draft-test",
        access_token="ghs_fake",
        repo_owner=repo_owner,
        repo_name=repo_name,
    )


class _FakeGithub:
    """Stub for `_prompts_submit.github_api` + `create_pull_request`.

    Records the changes that would be PUT to GitHub so tests can
    inspect them. Returns the original source for content GETs so
    submit_drafts can apply edits without a real network call.

    Captures, in order:
      * `gets`        — list of GET-style endpoint strings hit
      * `put_changes` — list of (path, decoded_utf8_content) tuples
                        the PR builder would commit

    The class also fakes `create_pull_request` so we don't actually
    create a PR; we just capture what would be committed and read
    those out in assertions.
    """

    def __init__(self, file_contents: dict[str, str]):
        # `file_contents` maps repo-relative path → utf-8 string. The
        # GET-content path returns the base64 of the corresponding
        # value.
        self.file_contents = file_contents
        self.gets: list[str] = []
        self.put_changes: list[tuple[str, str]] = []

    def github_api_impl(self, endpoint: str, access_token: str, *, method: str = "GET", body=None):
        self.gets.append(endpoint)
        # GET /repos/.../contents/<path>
        if method == "GET" and "/contents/" in endpoint:
            # Strip query string (the impl appends ?ref=branch on later GETs)
            ep = endpoint.split("?", 1)[0]
            path = ep.split("/contents/", 1)[1]
            content = self.file_contents.get(path)
            if content is None:
                from artanis_gravel._github_api import GitHubAPIError
                raise GitHubAPIError("not found", 404)
            import base64

            return {"content": base64.b64encode(content.encode()).decode(), "encoding": "base64"}
        return {}  # unused for non-content GETs in this stub

    def create_pr_impl(self, **kwargs):
        for change in kwargs["changes"]:
            self.put_changes.append((change.path, change.content))
        from artanis_gravel._github_api import CreatePullRequestResult

        return CreatePullRequestResult(
            pr_url="https://github.com/acme/app/pull/42",
            pr_number=42,
            branch_name=kwargs.get("branch_name", "gravel/draft-test"),
        )


def _patch_submit_with(monkeypatch, fake: _FakeGithub) -> None:
    """Patch out the network surface in `_prompts_submit` so submit_drafts
    runs purely against the FakeGithub fixture."""
    import artanis_gravel._prompts_submit as ps

    monkeypatch.setattr(ps, "github_api", fake.github_api_impl)
    monkeypatch.setattr(ps, "create_pull_request", fake.create_pr_impl)


def test_submit_drafts_pr_replaces_correct_byte_range_in_source(monkeypatch, tmp_path):
    """The PR's `prompts.py` change should contain SOURCE with ONLY
    p_user's text replaced — system + assistant prompts untouched.

    This is the core "did we get the slice right" assertion for the
    OUTBOUND side of the journey (dashboard → PR). If the edit
    applies to the wrong byte range, the merged PR clobbers code
    or other prompts."""
    repo_root = _write_manifest_and_chdir(monkeypatch, tmp_path)
    fake = _FakeGithub({"prompts.py": SOURCE})
    _patch_submit_with(monkeypatch, fake)

    from artanis_gravel._prompts_submit import DraftInput, submit_drafts

    new_user_text = "Summarise in three bullet points.\n"
    submit_drafts(
        _mk_resolved_args(
            repo_root,
            [DraftInput(prompt_id="p_user", new_text=new_user_text)],
        )
    )

    changes = dict(fake.put_changes)
    assert "prompts.py" in changes
    new_source = changes["prompts.py"]
    # The bytes before USER_START and after USER_END must be byte-equal
    # to the original — only the user-prompt body changes.
    assert new_source[:USER_START] == SOURCE[:USER_START], "bytes BEFORE the edit shifted"
    assert new_source[USER_START : USER_START + len(new_user_text)] == new_user_text
    expected_tail = SOURCE[USER_END:]
    assert new_source[USER_START + len(new_user_text) :] == expected_tail, (
        "bytes AFTER the edit drifted"
    )


def test_submit_drafts_manifest_shifts_subsequent_prompts_when_adding_lines(monkeypatch, tmp_path):
    """User makes p_user LONGER (adds lines). p_assistant (which comes
    after it in the file) must have its charStart / charEnd / lineStart /
    lineEnd shifted by the length delta. p_system (before the edit)
    stays put.

    This is the manifest-rewrite invariant. Without it, the merged
    PR's `.gravel/manifest.json` points at the wrong byte range and
    the next dashboard request returns garbage."""
    repo_root = _write_manifest_and_chdir(monkeypatch, tmp_path)
    fake = _FakeGithub({"prompts.py": SOURCE})
    _patch_submit_with(monkeypatch, fake)

    from artanis_gravel._prompts_submit import DraftInput, submit_drafts

    # Old USER body is 24 chars; new body is longer.
    old_user_len = USER_END - USER_START
    new_user_text = "Summarise the document.\nAdd three bullets.\nKeep it concise.\n"
    delta = len(new_user_text) - old_user_len

    submit_drafts(
        _mk_resolved_args(
            repo_root,
            [DraftInput(prompt_id="p_user", new_text=new_user_text)],
        )
    )

    # The manifest change in the PR is the LAST entry (submit_drafts
    # always appends MANIFEST_PATH at the end).
    manifest_change = next(
        (path, content) for path, content in fake.put_changes if path.endswith("manifest.json")
    )
    written = json.loads(manifest_change[1])
    by_id = {p["id"]: p for p in written["prompts"]}

    # p_system was BEFORE the edit; offsets unchanged.
    assert by_id["p_system"]["charStart"] == SYSTEM_START
    assert by_id["p_system"]["charEnd"] == SYSTEM_END

    # p_user was the edited prompt; its charStart unchanged, charEnd
    # extended by exactly the delta.
    assert by_id["p_user"]["charStart"] == USER_START
    assert by_id["p_user"]["charEnd"] == USER_START + len(new_user_text)

    # p_assistant was AFTER the edit; its offsets shift by +delta.
    assert by_id["p_assistant"]["charStart"] == ASSISTANT_START + delta
    assert by_id["p_assistant"]["charEnd"] == ASSISTANT_END + delta

    # Line numbers must shift too — the new_user_text has more
    # newlines, so p_assistant moves down by `delta_lines`.
    delta_lines = new_user_text.count("\n") - SOURCE[USER_START:USER_END].count("\n")
    assert by_id["p_assistant"]["lineStart"] == 13 + delta_lines
    assert by_id["p_assistant"]["lineEnd"] == 13 + delta_lines


def test_submit_drafts_manifest_shifts_when_removing_lines(monkeypatch, tmp_path):
    """Mirror of the previous test for negative deltas: shrink p_user
    and confirm p_assistant moves UP."""
    repo_root = _write_manifest_and_chdir(monkeypatch, tmp_path)
    fake = _FakeGithub({"prompts.py": SOURCE})
    _patch_submit_with(monkeypatch, fake)

    from artanis_gravel._prompts_submit import DraftInput, submit_drafts

    old_user_len = USER_END - USER_START
    new_user_text = "Summarise.\n"  # much shorter
    delta = len(new_user_text) - old_user_len
    assert delta < 0, "test assumes shrink"

    submit_drafts(
        _mk_resolved_args(
            repo_root,
            [DraftInput(prompt_id="p_user", new_text=new_user_text)],
        )
    )

    manifest_change = next(
        (path, content) for path, content in fake.put_changes if path.endswith("manifest.json")
    )
    written = json.loads(manifest_change[1])
    by_id = {p["id"]: p for p in written["prompts"]}

    assert by_id["p_system"]["charStart"] == SYSTEM_START
    assert by_id["p_user"]["charEnd"] == USER_START + len(new_user_text)
    assert by_id["p_assistant"]["charStart"] == ASSISTANT_START + delta
    assert by_id["p_assistant"]["charEnd"] == ASSISTANT_END + delta


def test_submit_drafts_multiple_edits_same_file_apply_descending(monkeypatch, tmp_path):
    """Two embedded edits in the same file. The submit pipeline must
    apply them in DESCENDING charStart order so the second apply
    doesn't shift offsets out from under the first.

    Concretely: editing p_user (later) and p_system (earlier) in the
    same PR — if we applied p_system first, then by the time we
    reached p_user the offsets in the manifest would be stale. The
    descending-charStart sort prevents that."""
    repo_root = _write_manifest_and_chdir(monkeypatch, tmp_path)
    fake = _FakeGithub({"prompts.py": SOURCE})
    _patch_submit_with(monkeypatch, fake)

    from artanis_gravel._prompts_submit import DraftInput, submit_drafts

    new_system = "Be very careful.\nBe extremely concise.\n"
    new_user = "Summarise in one sentence.\n"

    submit_drafts(
        _mk_resolved_args(
            repo_root,
            [
                DraftInput(prompt_id="p_user", new_text=new_user),
                DraftInput(prompt_id="p_system", new_text=new_system),
            ],
        )
    )

    # The source change in the PR must be the result of BOTH edits.
    src_change = next(content for path, content in fake.put_changes if path == "prompts.py")

    # Bytes before SYSTEM_START unchanged.
    assert src_change[:SYSTEM_START] == SOURCE[:SYSTEM_START]
    # SYSTEM body replaced.
    assert src_change[SYSTEM_START : SYSTEM_START + len(new_system)] == new_system
    # The new file must contain the new USER text somewhere.
    assert new_user in src_change
    # ASSISTANT body must remain identical.
    assert SOURCE[ASSISTANT_START:ASSISTANT_END] in src_change


def test_submit_drafts_manifest_hash_updates_only_for_edited_prompts(monkeypatch, tmp_path):
    """An edited prompt gets a fresh sha256 hash. An unedited prompt
    in the SAME file (whose offsets shift but content stays the same)
    keeps its existing hash. Without this, every cross-prompt offset
    shift would invalidate downstream hash-based pinning."""
    repo_root = _write_manifest_and_chdir(monkeypatch, tmp_path)
    fake = _FakeGithub({"prompts.py": SOURCE})
    _patch_submit_with(monkeypatch, fake)

    from artanis_gravel._prompts_submit import DraftInput, submit_drafts

    submit_drafts(
        _mk_resolved_args(
            repo_root,
            [DraftInput(prompt_id="p_user", new_text="totally new user text\n")],
        )
    )
    manifest_change = next(
        (path, content) for path, content in fake.put_changes if path.endswith("manifest.json")
    )
    written = json.loads(manifest_change[1])
    by_id = {p["id"]: p for p in written["prompts"]}

    # p_user: hash changed.
    assert by_id["p_user"]["hash"] != "sha256:2"
    assert by_id["p_user"]["hash"].startswith("sha256:")
    # p_assistant: shifted but unchanged content → hash preserved.
    assert by_id["p_assistant"]["hash"] == "sha256:3"
    # p_system: untouched, before the edit → hash preserved.
    assert by_id["p_system"]["hash"] == "sha256:1"


def test_submit_drafts_file_type_prompt_replaces_whole_file(monkeypatch, tmp_path):
    """A file-type prompt: the draft IS the entire new content. The
    PR's PUT for that path must equal the draft's new_text verbatim,
    and the manifest entry's hash must be the hash of the new content."""
    repo_root = tmp_path
    (repo_root / "agent.md").write_text("old content\n", encoding="utf-8")
    (repo_root / ".gravel").mkdir()
    (repo_root / ".gravel" / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "prompts": [
                    {"id": "p_file", "type": "file", "path": "agent.md", "hash": "sha256:old"}
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.chdir(repo_root)

    fake = _FakeGithub({"agent.md": "old content\n"})
    _patch_submit_with(monkeypatch, fake)

    from artanis_gravel._prompts_submit import DraftInput, submit_drafts

    new = "completely new agent instructions\nover two lines\n"
    submit_drafts(_mk_resolved_args(repo_root, [DraftInput("p_file", new)]))

    src_change = next(c for path, c in fake.put_changes if path == "agent.md")
    assert src_change == new

    manifest_change = next(c for path, c in fake.put_changes if path.endswith("manifest.json"))
    written = json.loads(manifest_change)
    by_id = {p["id"]: p for p in written["prompts"]}
    assert by_id["p_file"]["hash"] != "sha256:old"
    assert by_id["p_file"]["hash"].startswith("sha256:")
