"""Pin `compute_manifest_diff_summary` against representative shapes.

The TS counterpart lives in packages/sdk-ts/src/prompts/submit.ts and is
exercised inline via submit tests; the Python port at
artanis_gravel._pr_body needs its own pinning so the diff computation
itself can't silently drift either."""
from __future__ import annotations

from artanis_gravel._pr_body import (
    ManifestDiffEntry,
    compute_manifest_diff_summary,
)
from artanis_gravel.manifest.types import (
    Manifest,
    ManifestPromptEmbedded,
    ManifestPromptFile,
)


def _pf(*, pid: str, path: str, hash_: str = "h") -> ManifestPromptFile:
    return ManifestPromptFile(id=pid, path=path, hash=hash_)


def _pe(
    *,
    pid: str,
    path: str,
    hash_: str = "h",
    line_start: int = 1,
    line_end: int = 1,
    char_start: int = 0,
    char_end: int = 10,
) -> ManifestPromptEmbedded:
    return ManifestPromptEmbedded(
        id=pid,
        path=path,
        hash=hash_,
        line_start=line_start,
        line_end=line_end,
        char_start=char_start,
        char_end=char_end,
    )


def test_empty_prev_with_nonempty_next_is_first_add() -> None:
    out = compute_manifest_diff_summary(
        Manifest(prompts=[]),
        Manifest(prompts=[_pf(pid="p1", path="a.md")]),
    )
    assert out == [ManifestDiffEntry(kind="first_add")]


def test_added_prompt_id() -> None:
    out = compute_manifest_diff_summary(
        Manifest(prompts=[_pf(pid="p1", path="a.md")]),
        Manifest(prompts=[_pf(pid="p1", path="a.md"), _pf(pid="p2", path="b.md")]),
    )
    assert out == [ManifestDiffEntry(kind="added", prompt_id="p2", path="b.md")]


def test_edited_when_hash_changes_same_path() -> None:
    out = compute_manifest_diff_summary(
        Manifest(prompts=[_pf(pid="p1", path="a.md", hash_="old")]),
        Manifest(prompts=[_pf(pid="p1", path="a.md", hash_="new")]),
    )
    assert out == [ManifestDiffEntry(kind="edited", prompt_id="p1", path="a.md")]


def test_removed_prompt_id() -> None:
    out = compute_manifest_diff_summary(
        Manifest(prompts=[_pf(pid="p1", path="a.md"), _pf(pid="p2", path="b.md")]),
        Manifest(prompts=[_pf(pid="p1", path="a.md")]),
    )
    assert out == [ManifestDiffEntry(kind="removed", prompt_id="p2", path="b.md")]


def test_renamed_when_path_changes_but_hash_stays() -> None:
    out = compute_manifest_diff_summary(
        Manifest(prompts=[_pf(pid="p1", path="old/a.md", hash_="h")]),
        Manifest(prompts=[_pf(pid="p1", path="new/a.md", hash_="h")]),
    )
    assert out == [
        ManifestDiffEntry(
            kind="renamed", prompt_id="p1", old_path="old/a.md", path="new/a.md"
        )
    ]


def test_path_and_hash_both_change_surfaces_as_edited() -> None:
    out = compute_manifest_diff_summary(
        Manifest(prompts=[_pf(pid="p1", path="old/a.md", hash_="old")]),
        Manifest(prompts=[_pf(pid="p1", path="new/a.md", hash_="new")]),
    )
    assert out == [ManifestDiffEntry(kind="edited", prompt_id="p1", path="new/a.md")]


def test_embedded_anchors_changed_when_offsets_shift() -> None:
    out = compute_manifest_diff_summary(
        Manifest(prompts=[_pe(pid="p1", path="src/a.py", char_start=10, char_end=20)]),
        Manifest(prompts=[_pe(pid="p1", path="src/a.py", char_start=15, char_end=25)]),
    )
    assert out == [
        ManifestDiffEntry(kind="anchors_changed", prompt_id="p1", path="src/a.py")
    ]


def test_embedded_unchanged_offsets_yields_no_diff() -> None:
    same = _pe(pid="p1", path="src/a.py", char_start=10, char_end=20)
    out = compute_manifest_diff_summary(
        Manifest(prompts=[same]), Manifest(prompts=[same])
    )
    assert out == []


def test_mixed_diff_collects_every_change() -> None:
    prev = Manifest(
        prompts=[
            _pf(pid="p_keep", path="keep.md", hash_="h"),
            _pf(pid="p_edit", path="edit.md", hash_="old"),
            _pf(pid="p_gone", path="gone.md", hash_="h"),
        ]
    )
    next_ = Manifest(
        prompts=[
            _pf(pid="p_keep", path="keep.md", hash_="h"),
            _pf(pid="p_edit", path="edit.md", hash_="new"),
            _pf(pid="p_new", path="new.md"),
        ]
    )
    out = compute_manifest_diff_summary(prev, next_)
    # Order: nextById iteration then prevById iteration → edited+added
    # come from the next pass, removed from the prev pass.
    kinds = sorted([(d.kind, d.prompt_id) for d in out])
    assert kinds == sorted(
        [
            ("edited", "p_edit"),
            ("added", "p_new"),
            ("removed", "p_gone"),
        ]
    )
