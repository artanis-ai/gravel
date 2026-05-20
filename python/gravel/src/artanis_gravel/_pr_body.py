"""PR body + title composition for the Python `gravel[bot]` submit path.

1:1 port of `packages/sdk-ts/src/github/create-pr.ts` and the
`computeManifestDiffSummary` half of `packages/sdk-ts/src/prompts/submit.ts`.
Olly's dogfooding session (2026-05-20, de_platform PR #249) caught that
the Python stack had never received the v0.8.0 PR-body upgrade — the
manifest explainer and the feedback link were emitted by the TS path
only. This module makes the two stacks byte-equal for the same inputs;
`python/gravel/tests/test_pr_body_cross_stack.py` pins that.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal
from urllib.parse import quote

from .manifest.types import MANIFEST_PATH, Manifest, ManifestPromptEmbedded

if TYPE_CHECKING:
    # Imported only for type-checkers to dodge the circular import:
    # _github_api defines PromptChange and create_pull_request, and
    # create_pull_request delegates here for the body.
    from ._github_api import PromptChange


# ---------- ManifestDiffEntry ----------------------------------------


# A single line item in the manifest's diff summary, used to explain
# the .gravel/manifest.json change to PR reviewers. Six kinds:
#   - first_add: manifest didn't exist before; just-added.
#   - added:     new prompt id appeared.
#   - edited:    existing id's hash (or path + hash) changed.
#   - removed:   prompt id disappeared.
#   - renamed:   same id + same hash, path moved (pure rename).
#   - anchors_changed: embedded prompt's resolved offsets shifted
#                      because surrounding code moved around it.
@dataclass(frozen=True)
class ManifestDiffEntry:
    kind: Literal[
        "first_add", "added", "edited", "removed", "renamed", "anchors_changed"
    ]
    prompt_id: str = ""
    path: str = ""
    old_path: str = ""


def compute_manifest_diff_summary(
    prev: Manifest, next_: Manifest
) -> list[ManifestDiffEntry]:
    """Diff two manifests at the prompt-entry level. Mirrors
    `computeManifestDiffSummary` in packages/sdk-ts/src/prompts/submit.ts."""
    if len(prev.prompts) == 0 and len(next_.prompts) > 0:
        return [ManifestDiffEntry(kind="first_add")]

    out: list[ManifestDiffEntry] = []
    prev_by_id = {p.id: p for p in prev.prompts}
    next_by_id = {p.id: p for p in next_.prompts}

    for pid, np in next_by_id.items():
        op = prev_by_id.get(pid)
        if op is None:
            out.append(ManifestDiffEntry(kind="added", prompt_id=pid, path=np.path))
            continue
        if op.path != np.path:
            if op.hash == np.hash:
                out.append(
                    ManifestDiffEntry(
                        kind="renamed",
                        prompt_id=pid,
                        old_path=op.path,
                        path=np.path,
                    )
                )
            else:
                # Path moved AND content changed — surface as edited;
                # the path move alone shows up in the file diff.
                out.append(
                    ManifestDiffEntry(kind="edited", prompt_id=pid, path=np.path)
                )
            continue
        if op.hash != np.hash:
            out.append(ManifestDiffEntry(kind="edited", prompt_id=pid, path=np.path))
            continue
        # Path + hash unchanged; check whether the embedded prompt's
        # resolved offsets shifted (surrounding code edited around it).
        if (
            isinstance(op, ManifestPromptEmbedded)
            and isinstance(np, ManifestPromptEmbedded)
            and (op.line_start != np.line_start or op.char_start != np.char_start)
        ):
            out.append(
                ManifestDiffEntry(
                    kind="anchors_changed", prompt_id=pid, path=np.path
                )
            )

    for pid, op in prev_by_id.items():
        if pid not in next_by_id:
            out.append(
                ManifestDiffEntry(kind="removed", prompt_id=pid, path=op.path)
            )

    return out


# ---------- describe_manifest_diff -----------------------------------


def describe_manifest_diff(diffs: list[ManifestDiffEntry]) -> list[str]:
    """Build human-readable PR-body bullets explaining each manifest-diff
    entry. Mirrors `describeManifestDiff` in packages/sdk-ts/src/github/create-pr.ts.

    `first_add` collapses to a single paragraph so reviewers get the
    "what is this file?" answer once; other cases enumerate per entry.
    """
    if not diffs:
        return []
    if any(d.kind == "first_add" for d in diffs):
        return [
            "**About `.gravel/manifest.json`:** this PR also adds the Gravel manifest. It tracks which prompts in this repo are managed by the embedded dashboard — your team edits these files in-app and Gravel opens a PR like this one when they hit Submit. Keep the file in the repo; future updates need it to know what lives where.",
        ]
    lines: list[str] = ["**Manifest changes** (`.gravel/manifest.json`):"]
    for d in diffs:
        if d.kind == "added":
            lines.append(
                f"- Added prompt `{d.path}` (id `{d.prompt_id}`). New entry tracked by the manifest."
            )
        elif d.kind == "edited":
            lines.append(
                f"- Updated prompt at `{d.path}` (id `{d.prompt_id}`). The content hash changed — that's the actual edit you're reviewing."
            )
        elif d.kind == "removed":
            lines.append(
                f"- Removed prompt `{d.path}` (id `{d.prompt_id}`). The manifest no longer tracks this file."
            )
        elif d.kind == "renamed":
            lines.append(
                f"- Renamed: `{d.old_path}` → `{d.path}` (id `{d.prompt_id}`). Same content (same hash); the manifest follows the move."
            )
        elif d.kind == "anchors_changed":
            lines.append(
                f"- Updated inline-prompt anchors for `{d.path}` (id `{d.prompt_id}`). The surrounding code shifted; the start/end markers moved with it."
            )
    return lines


# ---------- default_pr_title -----------------------------------------


def default_pr_title(paths: list[str]) -> str:
    """Software-default PR title. Deterministic. Mirrors `defaultPRTitle`
    in packages/sdk-ts/src/github/create-pr.ts byte-for-byte.

      1 file:  `Update judge.txt`
      2:        `Update judge.txt and rewrite.txt`
      3:        `Update judge.txt, rewrite.txt and triage.md`
      4+:       `Update judge.txt, rewrite.txt and 3 others`
    """
    names = [p.split("/")[-1] for p in paths if p.split("/")[-1]]
    if len(names) == 0:
        return "Update prompts"
    if len(names) == 1:
        return f"Update {names[0]}"
    if len(names) == 2:
        return f"Update {names[0]} and {names[1]}"
    if len(names) == 3:
        return f"Update {names[0]}, {names[1]} and {names[2]}"
    remaining = len(names) - 2
    return f"Update {names[0]}, {names[1]} and {remaining} others"


# ---------- compose_pr_body ------------------------------------------


def compose_pr_body(
    *,
    description: str | None,
    de_first_name: str | None,
    changes: list[PromptChange],
    manifest_diff: list[ManifestDiffEntry] | None,
    repo_owner: str,
    repo_name: str,
    branch_name: str,
) -> str:
    """Compose the full PR body — header line, optional description,
    files-changed list (when >1 prompt file), manifest explainer,
    footer with Gravel link + feedback mailto. Mirrors `composeBody`
    in packages/sdk-ts/src/github/create-pr.ts.

    The Python stack reaches this from `_github_api.create_pull_request`
    once the submit path computes the manifest diff.
    """
    lines: list[str] = []
    if de_first_name:
        lines.append(f"On behalf of {de_first_name}.")
    if description and description.strip():
        lines.append("")
        lines.append(description.strip())

    # Filter out the manifest itself from the human-facing "Files
    # changed" — it always changes alongside prompt edits and reviewers
    # get a dedicated explanation below.
    prompt_changes = [c for c in changes if c.path != MANIFEST_PATH]
    if len(prompt_changes) > 1:
        lines.append("")
        lines.append(f"**Files changed ({len(prompt_changes)}):**")
        for c in prompt_changes:
            lines.append(f"- `{c.path}`")

    manifest_lines = describe_manifest_diff(manifest_diff or [])
    if manifest_lines:
        lines.append("")
        lines.extend(manifest_lines)

    # Footer: link to Gravel + feedback link prefilled with repo +
    # branch so the maintainer can see install context.
    repo_param = quote(f"{repo_owner}/{repo_name}", safe="")
    branch_param = quote(branch_name, safe="")
    feedback_url = (
        f"https://gravel.artanis.ai/feedback?repo={repo_param}&branch={branch_param}"
    )
    lines.append("")
    lines.append("---")
    lines.append(
        f"<sub>PR created via [Gravel](https://gravel.artanis.ai). [Send feedback →]({feedback_url})</sub>"
    )

    # Drop any leading blank lines from the join. The TS path uses
    # `.trimStart()`; Python `lstrip("\n")` does the equivalent for our
    # `\n`-joined output (no other whitespace shows up at the start).
    return "\n".join(lines).lstrip("\n")
