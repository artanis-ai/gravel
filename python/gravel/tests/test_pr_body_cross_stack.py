"""Cross-stack PR-body equivalence test.

Loads the shared `tests/fixtures/pr-body/cases.json` fixture and asserts
each expected body matches `compose_pr_body`'s output byte-for-byte.
The TS sibling at `packages/sdk-ts/tests/pr-body-cross-stack.test.ts`
runs the same fixture through `composeBody` — if both pass, the two
stacks are guaranteed equivalent for the inputs covered.

Why this exists: v0.8.0 shipped the manifest explainer + feedback link
in the TS submit path, but `_compose_body` in the Python `_github_api`
was the pre-v0.8.0 stub. Olly's dogfooding (2026-05-20, de_platform PR
#249) was on the Python stack and silently lost both. The
audit-seams-not-parts memory predicted exactly this kind of drift; this
fixture is the safety net so the same regression can't ship again.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from artanis_gravel._github_api import PromptChange
from artanis_gravel._pr_body import (
    ManifestDiffEntry,
    compose_pr_body,
    default_pr_title,
    describe_manifest_diff,
)


FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "pr-body" / "cases.json"


def _load_cases() -> list[dict]:
    with FIXTURE.open(encoding="utf-8") as f:
        doc = json.load(f)
    return doc["cases"]


def _diff_from_fixture(items: list[dict] | None) -> list[ManifestDiffEntry] | None:
    if items is None:
        return None
    out: list[ManifestDiffEntry] = []
    for d in items:
        kwargs: dict = {"kind": d["kind"]}
        if "promptId" in d:
            kwargs["prompt_id"] = d["promptId"]
        if "path" in d:
            kwargs["path"] = d["path"]
        if "oldPath" in d:
            kwargs["old_path"] = d["oldPath"]
        out.append(ManifestDiffEntry(**kwargs))
    return out


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["name"])
def test_cross_stack_body_matches_fixture(case: dict) -> None:
    """Every fixture case: Python output must equal the fixture's
    `expectedBody`. The TS sibling test asserts the same string, so
    failing here AND/OR there points at exactly which stack drifted."""
    inp = case["input"]
    body = compose_pr_body(
        description=inp.get("description"),
        de_first_name=inp.get("deFirstName"),
        changes=[
            PromptChange(path=c["path"], content=c["content"]) for c in inp["changes"]
        ],
        manifest_diff=_diff_from_fixture(inp.get("manifestDiff")),
        repo_owner=inp["repoOwner"],
        repo_name=inp["repoName"],
        branch_name=inp["branchName"],
    )
    assert body == case["expectedBody"], (
        f"\n--- expected ---\n{case['expectedBody']}\n"
        f"--- actual ---\n{body}\n"
    )


# Unit tests for the helpers themselves (matches the TS coverage in
# create-pr-helpers.test.ts). Kept separate from the cross-stack file
# so a helper regression surfaces independently of a fixture drift.


class TestDefaultPRTitle:
    def test_zero_files(self) -> None:
        assert default_pr_title([]) == "Update prompts"

    def test_one_file(self) -> None:
        assert default_pr_title(["api/py/prompts/judge.txt"]) == "Update judge.txt"

    def test_two_files(self) -> None:
        assert (
            default_pr_title(["a/judge.txt", "b/rewrite.txt"])
            == "Update judge.txt and rewrite.txt"
        )

    def test_three_files(self) -> None:
        assert (
            default_pr_title(["judge.txt", "rewrite.txt", "triage.md"])
            == "Update judge.txt, rewrite.txt and triage.md"
        )

    def test_four_files(self) -> None:
        assert (
            default_pr_title(
                ["judge.txt", "rewrite.txt", "triage.md", "discharge.md"]
            )
            == "Update judge.txt, rewrite.txt and 2 others"
        )

    def test_strips_dirs(self) -> None:
        assert (
            default_pr_title(["deep/nested/path/onboarding.md"])
            == "Update onboarding.md"
        )


class TestDescribeManifestDiff:
    def test_empty(self) -> None:
        assert describe_manifest_diff([]) == []

    def test_first_add_collapses(self) -> None:
        out = describe_manifest_diff([ManifestDiffEntry(kind="first_add")])
        assert len(out) == 1
        assert "About `.gravel/manifest.json`" in out[0]
        assert "tracks which prompts" in out[0]

    def test_added(self) -> None:
        out = describe_manifest_diff(
            [ManifestDiffEntry(kind="added", prompt_id="p_new1", path="prompts/new.md")]
        )
        assert out[0] == "**Manifest changes** (`.gravel/manifest.json`):"
        assert out[1] == (
            "- Added prompt `prompts/new.md` (id `p_new1`). "
            "New entry tracked by the manifest."
        )

    def test_edited(self) -> None:
        out = describe_manifest_diff(
            [ManifestDiffEntry(kind="edited", prompt_id="p_e", path="prompts/j.txt")]
        )
        assert "Updated prompt at `prompts/j.txt`" in out[1]
        assert "hash changed" in out[1]

    def test_removed(self) -> None:
        out = describe_manifest_diff(
            [ManifestDiffEntry(kind="removed", prompt_id="p_d", path="prompts/dead.md")]
        )
        assert "Removed prompt `prompts/dead.md`" in out[1]
        assert "no longer tracks" in out[1]

    def test_renamed(self) -> None:
        out = describe_manifest_diff(
            [
                ManifestDiffEntry(
                    kind="renamed",
                    prompt_id="p_m",
                    old_path="old/path.md",
                    path="new/path.md",
                )
            ]
        )
        assert "Renamed:" in out[1]
        assert "`old/path.md`" in out[1]
        assert "`new/path.md`" in out[1]
        assert "Same content" in out[1]

    def test_anchors_changed(self) -> None:
        out = describe_manifest_diff(
            [
                ManifestDiffEntry(
                    kind="anchors_changed", prompt_id="p_a", path="src/agent.py"
                )
            ]
        )
        assert "inline-prompt anchors" in out[1]
        assert "start/end markers moved" in out[1]
